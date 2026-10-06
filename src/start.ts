import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

// Every role in one process tree.
// THIS EXISTS FOR PLATFORMS THAT ONLY SELL WEB SERVICES. The design is three separate
// deployables — docker-compose.prod.yml runs them as three services, and that is the
// arrangement the project is actually about, because a worker pool you can scale
// independently of the API is the point of having a queue at all. Render's free tier
// has no background workers, so on that plan the choice is one container running
// everything or nothing running at all.

// What is lost, said plainly rather than buried:
//   - The API and the workers now share a CPU and an event loop's worth of scheduling.
//     A busy worker makes the dashboard slower, which on separate services it does not.
//   - `--scale worker=3` is gone. Concurrency inside the one process is the only dial.
//   - One crash takes all three down, which is why this exits on any child exiting
//     rather than limping on.
// What survives: the processes are still separate OS processes with separate Redis
// connections, so the handoff, the heartbeat and the reaper all behave exactly as they
// do in production. This is a packaging compromise, not an architectural one.

const DIST = resolve(import.meta.dirname);

// Order matters. migrate must finish before anything queries a table, and the API has
// to be the one holding the port because that is what the platform health-checks.
const ROLES = [
  { name: "api", script: "api/index.js" },
  { name: "worker", script: "worker/index.js" },
  { name: "scheduler", script: "scheduler/index.js" },
] as const;

const children: ChildProcess[] = [];
let shuttingDown = false;

function log(message: string): void {
  process.stdout.write(`[start] ${message}\n`);
}

// Run the migration and wait for it.
// There is no pre-deploy hook on a free plan, so this is the only place it can happen.
// Everything in schema.sql is IF NOT EXISTS, so running it on every boot is a no-op
// after the first — which is what makes it safe to put in the startup path rather than
// in a deploy step somebody has to remember.
function migrate(): Promise<void> {
  return new Promise((ok, fail) => {
    log("running migrations");

    const child = spawn(process.execPath, [resolve(DIST, "db/migrate.js")], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      if (code === 0) return ok();
      fail(new Error(`migration exited with code ${code}`));
    });
    child.on("error", fail);
  });
}

// Was this exit somebody asking the process to stop, rather than it falling over?
// FOUND BY RUNNING IT. A SIGTERM to the process GROUP — which is what a shell sends,
// and what some supervisors send — reaches the children directly, at the same moment
// it reaches this process. The child's exit event can then fire before this process's
// own signal handler has run, so `shuttingDown` is still false and a perfectly normal
// stop gets reported as a crash and exits 1. On Render that would make every routine
// sleep look like a failed deploy.
// Node reports it two ways depending on how the signal arrived: `signal` is set when
// it killed the child directly, and `code` is 128 + the signal number when the child
// handled it and exited itself — 143 for SIGTERM, 130 for SIGINT. Both mean the same
// thing here.
function wasSignalled(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal === "SIGTERM" || signal === "SIGINT") return true;
  return code === 143 || code === 130;
}

function startRoles(): void {
  for (const role of ROLES) {
    const child = spawn(process.execPath, [resolve(DIST, role.script)], {
      stdio: "inherit",
      env: process.env,
    });

    children.push(child);
    log(`started ${role.name} (pid ${child.pid})`);

    // ANY CHILD DYING KILLS THE CONTAINER, on purpose.
    //
    // The alternative is a container that still answers the health check because the
    // API is up, while the worker that actually does the work has been dead for
    // hours. The platform cannot see that, so nothing restarts it and the queue
    // silently stops draining. Exiting makes the failure visible to the one thing
    // watching — the orchestrator — which restarts the lot.
    child.on("exit", (code, signal) => {
      if (shuttingDown || wasSignalled(code, signal)) return;

      log(`${role.name} exited unexpectedly (code=${code} signal=${signal}) — stopping all`);
      stop("SIGTERM").then(() => process.exit(1), () => process.exit(1));
    });
  }
}

// Pass the signal down and wait.
// Forwarding rather than exiting is what makes the graceful shutdown work apply here:
// each child stops taking new work, finishes what it holds, and removes its own
// heartbeat. Killing this process alone would orphan them mid-job.
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log(`${signal} — draining ${children.length} process(es)`);
  for (const child of children) child.kill(signal);

  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((done) => {
          if (child.exitCode !== null || child.signalCode !== null) return done();
          child.once("exit", () => done());
        }),
    ),
  );

  log("all stopped");
}

async function main(): Promise<void> {
  // REGISTERED BEFORE ANYTHING IS SPAWNED, so a signal arriving during the migration
  // or in the moment after the children start still sets `shuttingDown` first. The
  // worker's own SHUTDOWN_TIMEOUT_MS bounds how long a drain takes, so there is no
  // second timer here — one budget in one place.
  process.on("SIGTERM", () => void stop("SIGTERM").then(() => process.exit(0)));
  process.on("SIGINT", () => void stop("SIGINT").then(() => process.exit(0)));

  await migrate();
  startRoles();
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
