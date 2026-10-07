import type { Redis } from "ioredis";
import { KEYS } from "./keys.js";
import type { Logger } from "./log.js";

// Heartbeat: workers periodically refresh a Redis key with a short TTL.
// If the worker stops refreshing it, Redis removes the key and the reaper
// can treat the worker as unavailable.

// How long the heartbeat survives without a refresh.
// Keep this comfortably above the refresh interval so temporary delays
// do not cause a healthy worker to be reaped.
export const TTL_S = Math.max(1, Number(process.env.HEARTBEAT_TTL_S ?? 30));

// How often the heartbeat is refreshed. Keep this well below the TTL.
const INTERVAL_MS = Math.max(200, Number(process.env.HEARTBEAT_INTERVAL_MS ?? 10_000));

export interface Heartbeat {
  // Stop beating. The key then expires on its own within TTL_S.
  stop(): void;
}

// Start the heartbeat and wait for the first beat before returning.
// This must happen before the worker takes jobs. Otherwise the reaper could
// see a worker holding jobs without a heartbeat and recover them prematurely.
export async function startHeartbeat(
  redis: Redis,
  workerId: string,
  log: Logger,
): Promise<Heartbeat> {
  const key = KEYS.alive(workerId);

  // Store the process ID for debugging. The system only uses the key's existence
  // to determine whether the worker is considered alive.
  const beat = () => redis.set(key, String(process.pid), "EX", TTL_S);

  await beat();

  const timer = setInterval(() => {
    // A temporary heartbeat failure should not immediately kill the worker.
    // If Redis remains unreachable long enough for the TTL to expire, the reaper
    // can recover the worker's jobs.
    void beat().catch((err: unknown) =>
      log.error(null, `heartbeat failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, INTERVAL_MS);

  // The heartbeat timer should not keep the process alive by itself.
  // The worker remains alive because it is waiting for and processing jobs.
  timer.unref();

  log.info(null, `heartbeat on ${key} every ${INTERVAL_MS}ms, expires after ${TTL_S}s`);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
