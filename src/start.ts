import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

// Start API, worker, and scheduler in one process tree (On platforms where I can't deploy separate worker services). 
// Used on platforms without separate background-worker services.
// Production deployments can run these roles as separate services.

const DIST = resolve(import.meta.dirname);

// Migration must finish before roles start.
// API owns the HTTP port used by platform health checks.
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

// Run database migrations before starting the application roles.
// Migrations are safe to run repeatedly because the schema uses IF NOT EXISTS.
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

// Detect normal SIGTERM/SIGINT exits so they aren't treated as crashes.
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

    // Stop the entire process tree if any role crashes.
    // This lets the platform restart the container instead of leaving
    // the API running while a worker or scheduler is dead.
    child.on("exit", (code, signal) => {
      if (shuttingDown || wasSignalled(code, signal)) return;

      log(`${role.name} exited unexpectedly (code=${code} signal=${signal}) — stopping all`);
      stop("SIGTERM").then(() => process.exit(1), () => process.exit(1));
    });
  }
}

// Forward the shutdown signal to all child processes and wait for them to exit.
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
  // Register shutdown handlers before migration or child processes start.
  process.on("SIGTERM", () => void stop("SIGTERM").then(() => process.exit(0)));
  process.on("SIGINT", () => void stop("SIGINT").then(() => process.exit(0)));

  await migrate();
  startRoles();
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
