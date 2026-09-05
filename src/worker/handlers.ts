import type { JobPayloads, JobRecord, JobType } from "../shared/types.js";
import type { Logger } from "../shared/log.js";

type Handler = (job: JobRecord, log: Logger) => Promise<void>;

/**
 * Deliberately boring, and kept on purpose.
 *
 * A real handler is a bad test subject for reliability work: when a webhook
 * delivery fails you cannot tell whether your reaper is broken or the receiver
 * is. This one has no failure modes of its own, takes a precisely known time, and
 * is trivially killable mid-flight — a controlled variable. Production queues
 * carry a job type like this for exactly the same reason.
 */
const sleep: Handler = async (job, log) => {
  const { ms } = job.payload as JobPayloads["sleep"];
  log.info(job.id, `started  (sleep ${ms}ms)`);

  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));

  log.info(job.id, `handler done in ${((Date.now() - startedAt) / 1000).toFixed(3)}s`);
};

/**
 * A fixture, not a feature. Without a job type that reliably throws, the failed
 * branch and the last_error column are unreachable and therefore untested.
 */
const alwaysFail: Handler = async (job) => {
  const { message } = job.payload as JobPayloads["always_fail"];
  throw new Error(message ?? "always_fail: this job type always throws");
};

/**
 * Deliver a webhook: POST JSON to someone else's server.
 *
 * This is the first handler that does real work, and it is the one that makes the
 * rest of the project matter. Everything about it is outside our control — the
 * receiver can be down, hung, overloaded, or simply slow — which is precisely why
 * work like this belongs in a queue rather than in a request handler.
 *
 * It is also what motivates the phases still to come:
 *
 *   Retries   a 503 from a service that is restarting deserves another attempt.
 *             Right now it does not get one, and the job is dead.
 *   Idempotency  delivering the same webhook twice is a real bug with real
 *             consequences for the receiver. Sleeping twice is harmless, which is
 *             why the argument for idempotency never lands until a handler has an
 *             effect on the outside world.
 *
 * Uses the built-in fetch (Node 18+). No HTTP library needed.
 */
const deliverWebhook: Handler = async (job, log) => {
  const { url, body, timeoutMs = 10_000 } = job.payload as JobPayloads["deliver_webhook"];

  log.info(job.id, `POST ${url} (attempt ${job.attempts}, timeout ${timeoutMs}ms)`);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        /**
         * Identifies the delivery, the way GitHub sends X-GitHub-Delivery and
         * Stripe sends an idempotency key. It lets the receiver recognise a
         * repeat of something it has already handled — which is the receiver's
         * half of the idempotency problem, and the reason this header exists
         * before we need it.
         */
        "X-QueueFlow-Job-Id": job.id,
        "X-QueueFlow-Attempt": String(job.attempts),
      },
      body: JSON.stringify(body ?? {}),
      /**
       * Without a timeout, a receiver that accepts the connection and then never
       * answers holds this worker forever. It would not fail, would not succeed,
       * and would never release its slot — the worst of the three outcomes,
       * because nothing anywhere would report a problem.
       */
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Transport-level: DNS failure, connection refused, or the timeout above.
    // The request never got an answer, so we cannot know whether the receiver
    // acted on it — which is exactly why the retry in Phase 4 will need the
    // receiver to be idempotent, not just this sender.
    const reason = err instanceof Error ? err.message : String(err);
    const kind = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable";
    throw new Error(`${url} ${kind} after ${Date.now() - startedAt}ms: ${reason}`);
  }

  const elapsed = Date.now() - startedAt;

  if (!response.ok) {
    // A 500 is a real answer, unlike the case above — the receiver was reached
    // and refused. Include a slice of the body; an error message that says only
    // "request failed" costs an hour of debugging later.
    const snippet = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`${url} responded ${response.status} after ${elapsed}ms: ${snippet}`);
  }

  log.info(job.id, `delivered ${response.status} in ${elapsed}ms`);
};

/**
 * Record<JobType, Handler> is exhaustive: add a name to JOB_TYPES and forget to
 * implement it here and the build fails. The type system will not let a job type
 * be accepted by the API that nothing can run.
 */
export const handlers: Record<JobType, Handler> = {
  sleep,
  always_fail: alwaysFail,
  deliver_webhook: deliverWebhook,
};
