import { describe, expect, test } from "vitest";

/**
 * The backoff policy on its own — no database, no Redis, no processes.
 *
 * Kept separate from retry.test.ts because it needs none of that: it is a pure
 * function of one number, and testing it here means the delay curve is checked in
 * milliseconds rather than inferred from timing a real retry cycle.
 */
const BASE = 1000;
const MAX = 60_000;
process.env.RETRY_BASE_MS = String(BASE);
process.env.RETRY_MAX_MS = String(MAX);

const { nextDelayMs } = await import("../src/shared/retry.js");

describe("backoff", () => {
  test("doubles with each attempt", () => {
    // Sampled, because jitter makes any single value a range.
    const floorFor = (attempts: number) => Math.min(2 ** attempts * BASE, MAX);

    for (const attempts of [1, 2, 3, 4, 5]) {
      const samples = Array.from({ length: 200 }, () => nextDelayMs(attempts));
      const floor = floorFor(attempts);

      // Never shorter than the exponential floor: jitter is added, not centred,
      // so a retry can be later than planned but never sooner.
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(floor);

      // And never more than 30% above it.
      expect(Math.max(...samples)).toBeLessThanOrEqual(floor * 1.3 + 1);
    }
  });

  test("is capped, so a late attempt is not scheduled days out", () => {
    // 2^20 seconds is about 12 days. The cap is what keeps a long-running retry
    // cycle retrying rather than effectively abandoning the job.
    for (const attempts of [10, 20, 40]) {
      expect(nextDelayMs(attempts)).toBeLessThanOrEqual(MAX * 1.3 + 1);
    }
  });

  test("jitter actually varies, so simultaneous failures do not resynchronise", () => {
    /**
     * The point of jitter: 500 jobs that failed in the same second must not all
     * retry in the same instant and rebuild the stampede that broke the receiver.
     * If this returned a constant, they would.
     */
    const samples = new Set(Array.from({ length: 200 }, () => nextDelayMs(3)));
    expect(samples.size).toBeGreaterThan(50);
  });

  test("the expected curve, for the record", () => {
    // Floors only — the observable schedule a failing job follows.
    expect([1, 2, 3, 4, 5].map((a) => Math.min(2 ** a * BASE, MAX))).toEqual([
      2000, 4000, 8000, 16_000, 32_000,
    ]);
  });
});
