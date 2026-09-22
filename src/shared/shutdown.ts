import type { Logger } from "./log.js";

// Graceful shutdown: the front door, as opposed to the reaper's fire exit.
// The reaper exists as an emergengy window, like this deals all cases machine dying, kill -9 or something asked process to stop
// either OS or user terminal action. But this creates a issue like we have to load each jobs from dead worker through reaper and this takes 
// time (30s (worker dead ttl) + 5 (reaper)), we can deal this to avoid few tasks if we confront the shutdown early.

// TWO SIGNALS, ONE MEANING.
//   SIGTERM  what `docker stop`, `docker compose restart` and every orchestrator send.
//   SIGINT   what Ctrl+C sends.
// They arrive for different reasons and want the same behaviour, so both land here.

// WHY THIS MATTERS MORE INSIDE A CONTAINER THAN OUT.

// The Dockerfile runs `CMD ["node", ...]`, so node is PID 1. Linux treats PID 1 as the
// machine's init process and protects it: a signal it has not EXPLICITLY asked for is
// ignored, rather than getting the usual default action. Ordinarily a Node process with
// no SIGTERM listener just exits; as PID 1 it does nothing at all.
// So without this file the sequence is always:
//   docker compose stop -> SIGTERM (ignored) -> 10s grace period -> SIGKILL
// Every container, every time — which is both why stopping the stack is slow and why
// every process here has only ever died the hard way.

// Registering a listener is what makes the signal stop being ignored. That is the whole
// mechanism; the draining each process does is the easy part.

export function onShutdown(
  log: Logger,
  drain: (signal: string) => Promise<void>,
): void {
  let draining = false;

  const handle = (signal: string) => {
    // THE SECOND SIGNAL IS AN ESCAPE HATCH, and it is not a nicety.
    // A drain can take tens of seconds by design. Somebody pressing Ctrl+C twice means "I do not care about the jobs, 
    // let go" — and a shutdown routine that ignores that is a shutdown routine people work around by reaching for kill -9,
    // which is exactly the habit this is trying to remove.
    if (draining) {
      log.error(null, `${signal} again — exiting immediately, in-flight work abandoned`);
      process.exit(1);
    }

    draining = true;
    log.info(null, `${signal} received — shutting down`);

    void drain(signal)
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        // Exit anyway. A process that cannot clean up must still stop; hanging here
        // would leave the orchestrator waiting out its grace period for a SIGKILL,
        // which is the behaviour this file exists to remove.
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
