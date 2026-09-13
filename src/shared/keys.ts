// Type-only, so it vanishes at compile time and this file stays what it is: the
// list of key names, with one helper that has to know what a Redis client is.
import type { Redis } from "ioredis";

// Every Redis key, in one place. Four structures:
//   pending      LIST    jobs waiting for any worker
//   processing   LIST    per worker — what w1 is holding right now
//   delayed      ZSET    failed jobs, scored by when they're due
//   alive        STRING  per worker, expires by itself — the heartbeat


// Every Redis key name this system uses, defined exactly once.
// The API and the worker are seprate processes that never import each other and never share memory.
// The only thing connecting them is that both send the string "queueflow:pending" to redis so if any of them sends different string 
// nothing errors, Redis just creates a second, empty list and we will never see it. API or worker just keep hitting wrong lists. And 
// worker blocks forever on a queue nobody writes to. That is a silent, hours-long bug, and it is caused by a typo in a string literal.

// Naming the key in one file turns it into an import error instead.

export const KEYS = {
  // LIST — jobs waiting to be picked up. Producer LPUSHes, worker BLMOVEs.
  pending: "queueflow:pending",

  // ZSET — jobs waiting out a retry backoff, scored by the epoch-ms they become due. A sorted set rather
  // than a list because the question being asked is "which of these are due now?", and ZRANGEBYSCORE 
  // answers it in log time without scanning. A list can only answer "what is at the end?".

  delayed: "queueflow:delayed",

  // LIST, one per worker — the jobs that worker is holding right now.

  // Situation/Problem: a worker takes a job with BRPOP, which REMOVES it from the pending list. The worker
  // then dies before it can finish the job. The job is gone, and Redis has no record of it. The reaper has no way
  // to know that the job was in progress, and it is lost forever. Postgress just says that it is in processing forever.
  // Solution: A single shared list would say "somebody is working on these" without saying who — and with no owner there
  // is no way to ask whether that owner is still alive, which is exactly the question the reaper has to answer. Putting the
  // worker id in the KEY NAME is what makes the list self-describing. Each worker has its own processing list, and the reaper 
  // SCANs for them. The reaper can then check each worker's "alive" key to see if the worker is still alive. If the worker is 
  // dead, the reaper can move the jobs back to pending. PER WORKER, not one shared "processing" list, and that is the whole design.

  processing: (workerId: string) => `queueflow:processing:${workerId}`,

  // Matches every worker's processing list. Used by the reaper's SCAN.
  processingPattern: "queueflow:processing:*",

  // STRING with a TTL — the worker's proof that it is still alive.

  // The worker rewrites this every few seconds with a short expiry. A living worker keeps refreshing it; a dead one stops,
  // and Redis deletes the key on its own once the expiry passes.
  // NOTHING HAS TO NOTICE THE DEATH. There is no monitor, no ping, no timeout bookkeeping — the absence of a key IS the notification,
  // and it is produced by Redis's expiry machinery rather than by any code in this project. This costs one SET per worker per interval.

  alive: (workerId: string) => `worker:${workerId}:alive`,

  // Matches every worker's heartbeat. Used by GET /workers.
  alivePattern: "worker:*:alive",
} as const;

// The inverse of KEYS.processing — pull the worker id back out of a key name.
// The reaper SCANs for processing lists and gets key names back, but the question it needs to ask is about the OWNER: is `worker:<id>:alive`
// still there? So the id has to survive the round trip through the key name, and this is the one place that decoding is allowed to happen.

export function workerIdFromProcessingKey(key: string): string | null {
  const prefix = "queueflow:processing:";
  if (!key.startsWith(prefix)) return null;

  const id = key.slice(prefix.length);
  return id.length > 0 ? id : null;
}

// The inverse of KEYS.alive, for the same reason.
export function workerIdFromAliveKey(key: string): string | null {
  const match = /^worker:(.+):alive$/.exec(key);
  return match?.[1] ?? null;
}

// Walk the keyspace for keys matching a pattern.

// SCAN, never KEYS. `KEYS` walks everything in a single command, and Redis is single-threaded — on a busy server that stops 
// every worker's BLMOVE for as long as the walk takes. SCAN hands back a cursor and a few keys at a time so other
// commands interleave. The cost is that SCAN offers no snapshot: a key created mid-walk may or may not show up. 
// Both callers here are fine with that, because anything missed is picked up on the next pass a few seconds later.

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
