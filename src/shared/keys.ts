import type { Redis } from "ioredis";

// Centralized Redis keys used by API, workers, scheduler, and reaper.
// These processes do not share memory, so Redis key strings are their contract.
// A typo in a key would not cause a Redis error; it would silently create/use
// another key, which could leave a producer and consumer talking to different queues.

export const KEYS = {
  // LIST — jobs waiting to be picked up.
  // Producer LPUSHes; workers BLMOVE jobs into their processing list.
  pending: "queueflow:pending",

  // ZSET — jobs waiting for retry backoff.
  // Score is the epoch time when the job becomes eligible again.
  // A ZSET lets the scheduler ask "which jobs are due now?" efficiently.
  delayed: "queueflow:delayed",

  // LIST — one per worker, containing jobs currently held by that worker.
  // Keeping this per-worker is important for recovery. If a worker takes a job
  // and dies, the job remains visible in processing:<workerId> instead of
  // disappearing from Redis as it would with BRPOP.
  // The worker ID in the key tells the reaper who owns the jobs. The reaper
  // can then check that worker's heartbeat and move its jobs back to pending
  // if the worker is dead.
  processing: (workerId: string) => `queueflow:processing:${workerId}`,

  // Matches every worker's processing list.
  // The reaper scans these keys to discover workers with in-flight jobs.
  processingPattern: "queueflow:processing:*",

  // STRING with a TTL — proves that a worker is still alive.
  // The worker refreshes this key periodically. If it stops refreshing,
  // Redis removes it after the TTL, giving the reaper a simple failure signal.
  alive: (workerId: string) => `worker:${workerId}:alive`,

  // Matches every worker heartbeat.
  // Used by GET /workers to discover live workers.
  alivePattern: "worker:*:alive",
} as const;

// Extract the worker ID from its processing-list key.
// The reaper uses this to connect a processing list to its owner.
export function workerIdFromProcessingKey(key: string): string | null {
  const prefix = "queueflow:processing:";
  if (!key.startsWith(prefix)) return null;

  const id = key.slice(prefix.length);
  return id.length > 0 ? id : null;
}

// Extract the worker ID from its heartbeat key.
export function workerIdFromAliveKey(key: string): string | null {
  const match = /^worker:(.+):alive$/.exec(key);
  return match?.[1] ?? null;
}

// Scan Redis incrementally for keys matching a pattern.
// Use SCAN instead of KEYS because KEYS can block Redis while walking the
// entire keyspace. SCAN returns small batches so normal worker commands can
// continue between iterations.
// SCAN is not a snapshot: a key can appear or disappear during the walk.
// That is fine here because the reaper runs repeatedly and can catch anything
// missed on the next pass.
export async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";

  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = next;
    found.push(...keys);
  } while (cursor !== "0");

  return found;
}