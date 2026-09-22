import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Runs N worker processes with distinct WORKER_IDs, in one terminal.
 *
 *   npm run dev:workers        -> 3 workers
 *   npm run dev:workers 5      -> 5 workers
 *
 * Exists for two reasons. The immediate one is that `WORKER_ID=w2 npm run
 * dev:worker` is a POSIX shell idiom that does not work in Windows cmd, so there
 * is no one-liner for starting a second worker here.
 *
 * The real reason is that starting and killing real worker processes is exactly
 * what the tests need — the concurrency proof spawns three, and the crash tests
 * spawn several and SIGKILL one mid-job. Killing a worker is not
 * something that can be simulated in-process: the whole point is that no cleanup
 * code runs.
 */
const here = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(here, "../worker/index.ts");

const count = Math.max(1, Number(process.argv[2] ?? 3));
const concurrency = process.env.CONCURRENCY ?? "1";

const children: ChildProcess[] = [];

for (let i = 1; i <= count; i++) {
  const id = `w${i}`;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--env-file=.env", workerEntry],
    {
      env: { ...process.env, WORKER_ID: id, CONCURRENCY: concurrency },
      // Pipe rather than inherit, so each line can be attributed to a worker even
      // when three of them interleave in one terminal.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const relay = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) stream.write(`${line}\n`);
    }
  };

  child.stdout?.on("data", (c: Buffer) => relay(c, process.stdout));
  child.stderr?.on("data", (c: Buffer) => relay(c, process.stderr));

  child.on("exit", (code, signal) => {
    process.stderr.write(`[dev] ${id} exited (code=${code} signal=${signal})\n`);
  });

  children.push(child);
}

process.stderr.write(`[dev] started ${count} workers, concurrency ${concurrency} each\n`);

/**
 * Forward Ctrl+C to the children. Without this the parent exits and leaves N
 * orphaned worker processes still holding BLMOVE connections — which then quietly
 * compete for jobs with whatever you start next, and are a genuine nuisance to
 * find afterwards.
 */
const shutdown = () => {
  process.stderr.write(`[dev] stopping ${children.length} workers\n`);
  for (const c of children) c.kill("SIGTERM");

  // WAIT FOR THEM, rather than exiting on a fixed timer.
  //
  // This used to exit after 500ms, which was fine while SIGTERM killed a worker outright.
  // Workers now drain their in-flight jobs first, so a fixed 500ms would cut the parent
  // loose mid-drain and hand the terminal back while N children were still finishing —
  // the orphaned-process nuisance this handler exists to prevent, just slower to notice.
  //
  // The cap is a backstop, not the normal path: a worker's own SHUTDOWN_TIMEOUT_MS
  // (25s by default) already bounds how long it can take, so reaching this means
  // something is genuinely stuck.
  let left = children.length;
  for (const c of children) c.once("exit", () => { if (--left === 0) process.exit(0); });

  setTimeout(() => {
    process.stderr.write(`[dev] ${left} worker(s) did not exit — killing\n`);
    for (const c of children) c.kill("SIGKILL");
    process.exit(1);
  }, 30_000).unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
