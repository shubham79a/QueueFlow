import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Who is allowed to WRITE.
//
// Reading stays open to everyone — the dashboard has to be viewable without signing in.
// Creating and replaying jobs do not, and deliver_webhook is the reason: an open POST /jobs
// means a stranger can make this server send a request to any URL they choose.
//
// Machine clients (a cron, another service) send a key. Human operators will send a session
// cookie once login exists — requireWrite is written to grow that second branch rather than
// become a second middleware.

// Comma-separated in .env. Empty means no key is configured.
const API_KEYS = (process.env.API_KEYS ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

// Exported so the API can warn loudly at startup. With no key configured the write routes
// stay open, so a fresh clone runs with no setup — but a deploy in that state is a mistake,
// and the operator should be told rather than left to find out.
export const AUTH_DISABLED = API_KEYS.length === 0;

// Pre-hashed once at startup, not on every request.
const KEY_DIGESTS = API_KEYS.map(sha256);

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Compare in constant time.
 *
 * `token === key` returns as soon as two characters differ, so the time it takes to answer
 * leaks how much of the key was right — enough, with many requests, to guess it a character
 * at a time. timingSafeEqual always reads both buffers fully.
 *
 * The comparison is on SHA-256 digests rather than the raw strings because timingSafeEqual
 * throws unless both buffers are the same length, and the length of the submitted token is
 * itself something we do not want to react to.
 */
function isKnownKey(token: string): boolean {
  const digest = sha256(token);
  return KEY_DIGESTS.some((known) => timingSafeEqual(digest, known));
}

/** Guards the routes that change something. */
export function requireWrite(req: Request, res: Response, next: NextFunction): void {
  if (AUTH_DISABLED) return next();

  const header = req.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (token && isKnownKey(token)) return next();

  // Deliberately says nothing about which key was tried, and the key never reaches the log.
  // 401 rather than 403: the caller has not proved who it is, as opposed to being known and
  // not allowed.
  res.status(401).json({ error: "missing or invalid API key" });
}
