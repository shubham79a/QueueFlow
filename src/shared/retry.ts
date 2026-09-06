/**
 * Backoff policy.
 *
 * Kept as a pure function in its own file so it can be tested without a database,
 * a Redis, or a fake clock — and so the policy is one readable place rather than an
 * expression buried in a catch block. This is the sort of decision a queue library
 * would make on your behalf.
 */

/**
 * Base unit of the delay. Overridable so tests can run a full five-attempt cycle
 * in under a second instead of thirty, without faking timers.
 */
const BASE_MS = Number(process.env.RETRY_BASE_MS ?? 1000);

/**
 * Ceiling on the delay.
 *
 * Without one, exponential growth stops being a backoff and becomes an
 * abandonment: attempt 12 would be scheduled four hours out. A cap says "keep
 * trying at a sensible interval" rather than "try again next week".
 */
const MAX_MS = Number(process.env.RETRY_MAX_MS ?? 60_000);

/** Fraction of the delay added at random. See the comment on jitter below. */
const JITTER = 0.3;

/**
 * How long to wait before the next attempt, given how many attempts have already
 * been made.
 *
 * EXPONENTIAL, not fixed: the first failure is usually a blip and deserves a quick
 * retry, but a service that has failed four times is having a real outage and
 * hammering it every two seconds makes its recovery harder, not faster. Doubling
 * backs off fastest exactly where the evidence of a real problem is strongest.
 *
 *   attempts 1 -> 2s      3 -> 8s       5 -> 32s
 *   attempts 2 -> 4s      4 -> 16s      6 -> 60s (capped)
 *
 * JITTER, and it is not a detail. Suppose one receiver goes down and 500 jobs fail
 * within the same second. Without jitter all 500 are scheduled for the same
 * instant, so they all retry together — rebuilding the exact stampede that broke
 * the receiver, and knocking it over again at the moment it comes back. Spreading
 * them across a window is what makes backoff help the thing being retried against
 * rather than just delaying the damage.
 *
 * The jitter is added rather than centred, so a delay is never shorter than the
 * exponential floor.
 */
export function nextDelayMs(attempts: number): number {
  const base = Math.min(2 ** attempts * BASE_MS, MAX_MS);
  return Math.round(base + Math.random() * base * JITTER);
}

/** Exposed for tests and for logging what policy is in force. */
export const retryConfig = { BASE_MS, MAX_MS, JITTER } as const;
