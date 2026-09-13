// Backoff policy.
// Retry logic is kept as function rather than a class so it can be tested without a database, a Redis, or a fake clock.
// Else this will be logic buried in a catch block, and the policy will be scattered across the codebase rather than in one place.

// Base unit of the delay. Overridable so tests can run a full five-attempt cycle in under a second instead of thirty, without faking timers.
const BASE_MS = Number(process.env.RETRY_BASE_MS ?? 1000);

// without this. we may schedule a retry so far in the future that the user has long since given up and moved on.
const MAX_MS = Number(process.env.RETRY_MAX_MS ?? 60_000);

const JITTER = 0.3;

// How long to wait before the next attempt, given how many attempts have already been made.
// EXPONENTIAL, not fixed: first failure may be a blip so we retry quickly and for further failures we back off more and more.
// Doubling backs off fastest exactly where the evidence of a real problem is strongest.
// Eg: attempts 1 -> 2s      3 -> 8s       5 -> 32s
//     attempts 2 -> 4s      4 -> 16s      6 -> 60s (capped)

// JITTER, and it is not a detail. Suppose one receiver goes down and 500 jobs fail within the same second.
// Without jitter all 500 are scheduled for the same instant, so they all retry together — rebuilding the exact stampede that broke
// the receiver, and knocking it over again at the moment it comes back. Spreading them across a window is what
// makes backoff help the thing being retried against rather than just delaying the damage.

// The jitter is added rather than centred, so a delay is never shorter than the exponential floor.

export function nextDelayMs(attempts: number): number {
  const base = Math.min(2 ** attempts * BASE_MS, MAX_MS);
  return Math.round(base + Math.random() * base * JITTER);
}

export const retryConfig = { BASE_MS, MAX_MS, JITTER } as const;