import type { Logger } from "./log.js";

// Graceful shutdown handles expected process termination before the reaper is needed.

// The reaper is the crash-recovery path. Graceful shutdown gives the worker a chance
// to stop taking new jobs and finish in-flight work, reducing recovery time and duplicates.

// SIGTERM is typically sent by Docker/orchestrators; SIGINT is sent by Ctrl+C.
// Both use the same graceful shutdown path.

// This process may run as PID 1 inside the container, so it must explicitly
// handle termination signals and perform its own graceful shutdown.

// Registering these handlers makes termination enter the drain path instead of
// immediately abandoning in-flight work.

export function onShutdown(
  log: Logger,
  drain: (signal: string) => Promise<void>,
): void {
  let draining = false;

  const handle = (signal: string) => {
    // A second signal is an emergency escape hatch: stop immediately instead of
    // waiting indefinitely for graceful draining to finish.
    if (draining) {
      log.error(null, `${signal} again — exiting immediately, in-flight work abandoned`);
      process.exit(1);
    }

    draining = true;
    log.info(null, `${signal} received — shutting down`);

    void drain(signal)
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        // Cleanup failure should still terminate the process so the orchestrator can
        // restart it and the reaper can recover any remaining jobs.
        log.error(
          null,
          `shutdown failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => handle("SIGTERM"));
  process.on("SIGINT", () => handle("SIGINT"));
}