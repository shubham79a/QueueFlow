import type { Redis } from "ioredis";
import { KEYS } from "./keys.js";
import type { Logger } from "./log.js";

// The heartbeat: how a worker says "still here", and how the system finds out when it stops saying it.

// There is no monitor process, no ping, no timeout bookkeeping. The worker writes a key with a short expiry and keeps 
// rewriting it. When the process dies it stops writing, and Redis deletes the key by itself once the expiry passes.
// THE ABSENCE OF THE KEY IS THE DEATH NOTICE, and it is produced by Redis's own expiry machinery rather than by any code here.

// How long the key survives without a refresh.

// THE RATIO TO THE INTERVAL IS THE WHOLE SETTING, and getting it wrong is the classic way to build a system that eats its
// own workers. The TTL must be a comfortable multiple of the interval, because a beat can be late for reasons
// that are not death: a garbage-collection pause, a slow moment on the Redis connection, a machine briefly starved of CPU.

// At the defaults — beat every 10s, key lives 30s — a worker can miss two beats in a row and still not be declared dead. 
// Set the TTL below the interval and a perfectly healthy worker is pronounced dead between every pair of beats, which
// is exactly the misconfiguration the crash tests use on purpose to force the double-execution case into the open.

export const TTL_S = Math.max(1, Number(process.env.HEARTBEAT_TTL_S ?? 30));

// How often the key is rewritten. Should be well under a third of the TTL.
const INTERVAL_MS = Math.max(200, Number(process.env.HEARTBEAT_INTERVAL_MS ?? 10_000));

export interface Heartbeat {
  // Stop beating. The key then expires on its own within TTL_S.
  stop(): void;
}

// Start beating, and do not return until the FIRST beat has landed.

// The await matters. If the worker started taking jobs before its first beat was
// written, it would be holding work while looking dead to everyone else, and the
// reaper would rescue jobs out from under a worker that had only just started.

// @param redis a NON-BLOCKING connection. Handing this the connection parked on
// BLMOVE would queue every beat behind the wait for the next job, so an idle
// worker — the one with the most capacity to spare — would be the first to be
// declared dead. This is the constraint that has made createRedis a factory
// since the first commit, finally being paid for.

export async function startHeartbeat(
  redis: Redis,
  workerId: string,
  log: Logger,
): Promise<Heartbeat> {
  const key = KEYS.alive(workerId);

  // The value is the process id. Nothing reads it — the system only ever asks
  // whether the key EXISTS — but when two processes are fighting over one
  // WORKER_ID, being able to see which pid last claimed it turns a baffling
  // afternoon into a one-command answer.
  const beat = () => redis.set(key, String(process.pid), "EX", TTL_S);

  await beat();

  const timer = setInterval(() => {
    // A failed beat is not fatal and must not kill the worker. Redis may be
    // reconnecting; the command is queued and will land. If it genuinely stays
    // down past the TTL this worker is declared dead and its jobs are rescued,
    // which is the correct outcome for a worker that cannot reach Redis anyway.
    void beat().catch((err: unknown) =>
      log.error(null, `heartbeat failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, INTERVAL_MS);

  // Do not let this timer alone hold the process open. A worker should stay alive
  // because it is waiting on the queue, never because a heartbeat is scheduled.
  timer.unref();

  log.info(null, `heartbeat on ${key} every ${INTERVAL_MS}ms, expires after ${TTL_S}s`);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
