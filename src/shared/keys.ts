// Type-only, so it vanishes at compile time and this file stays what it is: the
// list of key names, with one helper that has to know what a Redis client is.
import type { Redis } from "ioredis";

/**
 * Every Redis key name this system uses, defined exactly once.
 *
 * The API and the worker are separate processes that never import each other and
 * never share memory. The ONLY thing connecting them is that both send the string
 * "queueflow:pending" to Redis. If one of them ever sends "queueflow:pendings",
 * nothing errors — Redis happily creates a second, empty list, the API keeps
 * returning 202, and the worker blocks forever on a queue nobody writes to.
 *
 * That is a silent, hours-long bug, and it is caused by a typo in a string literal.
 * Naming the key in one file turns it into an import error instead.
 */
export const KEYS = {
  /** LIST — jobs waiting to be picked up. Producer LPUSHes, worker BLMOVEs. */
  pending: "queueflow:pending",

  /**
   * ZSET — jobs waiting out a retry backoff, scored by the epoch-ms they become
   * due. A sorted set rather than a list because the question being asked is
   * "which of these are due now?", and ZRANGEBYSCORE answers it in log time
   * without scanning. A list can only answer "what is at the end?".
   */
  delayed: "queueflow:delayed",

  /**
   * LIST, one per worker — the jobs that worker is holding right now.
   *
   * This is the key that makes a crash survivable, and it is worth being precise
   * about why. Until now a worker took a job with BRPOP, which REMOVES it: the
   * instant the id crossed the socket, Redis had forgotten the job existed. A
   * worker killed a millisecond later took the only copy with it.
   *
   * Now the id is MOVED here instead of removed, in one atomic step, so at every
   * instant it is in exactly one list — pending, or exactly one worker's
   * processing list. Kill the process and the id is still sitting here, in Redis,
   * with the owner's name in the key. Something else can find it and put it back.
   *
   * PER WORKER, not one shared "processing" list, and that is the whole design.
   * A single shared list would say "somebody is working on these" without saying
   * who — and with no owner there is no way to ask whether that owner is still
   * alive, which is exactly the question the reaper has to answer. Putting the
   * worker id in the KEY NAME is what makes the list self-describing.
   */
  processing: (workerId: string) => `queueflow:processing:${workerId}`,

  /** Matches every worker's processing list. Used by the reaper's SCAN. */
  processingPattern: "queueflow:processing:*",

  /**
   * STRING with a TTL — the worker's proof that it is still alive.
   *
   * The worker rewrites this every few seconds with a short expiry. A living
   * worker keeps refreshing it; a dead one stops, and Redis deletes the key on its
   * own once the expiry passes.
   *
   * NOTHING HAS TO NOTICE THE DEATH. There is no monitor, no ping, no timeout
   * bookkeeping — the absence of a key IS the notification, and it is produced by
   * Redis's expiry machinery rather than by any code in this project. That is the
   * cheapest failure detector available, and it costs one SET per worker per
   * interval.
   */
  alive: (workerId: string) => `worker:${workerId}:alive`,

  /** Matches every worker's heartbeat. Used by GET /workers. */
  alivePattern: "worker:*:alive",
} as const;

/**
 * The inverse of KEYS.processing — pull the worker id back out of a key name.
 *
 * The reaper SCANs for processing lists and gets key names back, but the question
 * it needs to ask is about the OWNER: is `worker:<id>:alive` still there? So the
 * id has to survive the round trip through the key name, and this is the one place
 * that decoding is allowed to happen.
 */
export function workerIdFromProcessingKey(key: string): string | null {
  const prefix = "queueflow:processing:";
  if (!key.startsWith(prefix)) return null;

  const id = key.slice(prefix.length);
  return id.length > 0 ? id : null;
}

/** The inverse of KEYS.alive, for the same reason. */
export function workerIdFromAliveKey(key: string): string | null {
  const match = /^worker:(.+):alive$/.exec(key);
  return match?.[1] ?? null;
}

/**
 * Walk the keyspace for keys matching a pattern.
 *
 * SCAN, never KEYS. `KEYS` walks everything in a single command, and Redis is
 * single-threaded — on a busy server that stops every worker's BLMOVE for as long
 * as the walk takes. SCAN hands back a cursor and a few keys at a time so other
 * commands interleave. The cost is that SCAN offers no snapshot: a key created
 * mid-walk may or may not show up. Both callers here are fine with that, because
 * anything missed is picked up on the next pass a few seconds later.
 */
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
