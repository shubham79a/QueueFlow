import { JOB_STATUSES, type JobStatus } from "../shared/types.js";

// Query parameters arrive as strings from strangers. Everything here turns one into
// a value the rest of the code can trust, or refuses it.
//
// The refusal matters as much as the parsing. Before this existed, `?limit=abc`
// reached Postgres as NaN and came back as a 500 with a stack trace in it — the
// caller's mistake reported as the server's fault.

/** Thrown for anything the caller got wrong. The error handler turns it into a 400. */
export class BadRequest extends Error {}

/**
 * How many rows to return.
 *
 * Clamped at BOTH ends. The previous version used Math.min alone, which caps the top
 * and lets a negative straight through to `LIMIT -5`.
 */
export function parseLimit(raw: unknown, fallback = 20, max = 100): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") throw new BadRequest("limit must be a single value");

  const n = Number(raw);
  // Number("") is 0 and Number(" ") is 0, so the emptiness check is not redundant.
  if (raw.trim() === "" || !Number.isFinite(n)) throw new BadRequest("limit must be a number");
  if (!Number.isInteger(n)) throw new BadRequest("limit must be a whole number");
  if (n < 1) throw new BadRequest("limit must be at least 1");

  return Math.min(n, max);
}

/**
 * A status filter, if there is one.
 *
 * An unknown status is a 400 rather than an empty list. `?status=died` returning
 * "no jobs" looks like an answer; it is a typo.
 */
export function parseStatus(raw: unknown): JobStatus | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BadRequest("status must be a single value");

  if (!(JOB_STATUSES as readonly string[]).includes(raw)) {
    throw new BadRequest(`unknown status '${raw}' — expected one of ${JOB_STATUSES.join(", ")}`);
  }
  return raw as JobStatus;
}

/**
 * Where the next page starts: a timestamp and the id that breaks ties on it.
 */
export interface Cursor {
  t: string;
  id: string;
}

/**
 * Cursors go out base64-encoded, and that is deliberate rather than decorative.
 *
 * The client cannot build one, so it cannot come to depend on the shape, which
 * leaves us free to page on something else later without breaking every caller. It
 * also stops anyone treating it as a filter — a cursor is a bookmark, not a query.
 */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: unknown): Cursor | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BadRequest("cursor must be a single value");

  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));

    // Anything can be base64-decoded into something; check the shape before trusting it.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Cursor).t !== "string" ||
      typeof (parsed as Cursor).id !== "string" ||
      Number.isNaN(Date.parse((parsed as Cursor).t))
    ) {
      throw new Error("shape");
    }

    return parsed as Cursor;
  } catch {
    // Never echo the value back — it came from outside, and a cursor is opaque by
    // design, so there is nothing useful to say about its contents.
    throw new BadRequest("invalid cursor");
  }
}
