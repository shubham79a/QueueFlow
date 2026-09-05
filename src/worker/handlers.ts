import type { JobRecord, JobType } from "../shared/types.js";
import type { Logger } from "../shared/log.js";

type Handler = (job: JobRecord, log: Logger) => Promise<void>;

/**
 * Deliberately boring. The job is not the subject of this project — the transport
 * is. A job that does nothing but take a visible amount of wall-clock time is the
 * ideal test subject: long enough to kill a worker in the middle of, with no
 * failure modes of its own to confuse the ones being studied.
 */
const sleep: Handler = async (job, log) => {
  const { ms } = job.payload as { ms: number };
  log.info(job.id, `started  (sleep ${ms}ms)`);

  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));

  log.info(job.id, `handler done in ${((Date.now() - startedAt) / 1000).toFixed(3)}s`);
};

/**
 * A test fixture, not a feature.
 *
 * Without a job type that reliably throws, the failed branch and the last_error
 * column are unreachable, which means they are also untested. This is the cheapest
 * way to exercise them — and in Phase 4 it becomes the thing that demonstrates
 * backoff and the dead-letter queue.
 */
const alwaysFail: Handler = async (job) => {
  const { message } = job.payload as { message?: string };
  throw new Error(message ?? "always_fail: this job type always throws");
};

export const handlers: Record<JobType, Handler> = {
  sleep,
  always_fail: alwaysFail,
};
