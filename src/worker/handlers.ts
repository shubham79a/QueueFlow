import type { Job, JobType } from "../shared/types.js";
import type { Logger } from "../shared/log.js";

type Handler = (job: Job, log: Logger) => Promise<void>;

/**
 * The only job type in Phase 1.
 *
 * It is deliberately boring. The job is not the subject of this project — the
 * transport is. A job that does nothing but take a visible amount of wall-clock
 * time is the ideal test subject: it is long enough to kill a worker in the middle
 * of, and it has no failure modes of its own to confuse the ones we are studying.
 */
const sleep: Handler = async (job, log) => {
  const { ms } = job.payload as { ms: number };
  log.info(job.id, `started  (sleep ${ms}ms)`);

  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));

  log.info(job.id, `finished in ${((Date.now() - startedAt) / 1000).toFixed(3)}s`);
};

export const handlers: Record<JobType, Handler> = {
  sleep,
};
