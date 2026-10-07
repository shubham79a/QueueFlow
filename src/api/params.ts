import { JOB_STATUSES, type JobStatus } from "../shared/types.js";

// Validate and parse query parameters.

// Error returned for invalid client input.
export class BadRequest extends Error { }

// Parse and clamp the requested page size.
export function parseLimit(raw: unknown, fallback = 20, max = 100): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") throw new BadRequest("limit must be a single value");

  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) throw new BadRequest("limit must be a number");
  if (!Number.isInteger(n)) throw new BadRequest("limit must be a whole number");
  if (n < 1) throw new BadRequest("limit must be at least 1");

  return Math.min(n, max);
}

// Parse an optional job status filter.
export function parseStatus(raw: unknown): JobStatus | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BadRequest("status must be a single value");

  if (!(JOB_STATUSES as readonly string[]).includes(raw)) {
    throw new BadRequest(`unknown status '${raw}' — expected one of ${JOB_STATUSES.join(", ")}`);
  }
  return raw as JobStatus;
}

// Cursor identifying where the next page starts.
export interface Cursor {
  t: string;
  id: string;
}

// Encode the cursor as an opaque base64 value.
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

// Decode and validate an opaque cursor.
export function decodeCursor(raw: unknown): Cursor | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BadRequest("cursor must be a single value");

  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));

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
    throw new BadRequest("invalid cursor");
  }
}