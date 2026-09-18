import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Who is allowed to WRITE.
//
// Reading stays open to everyone — the dashboard has to be viewable without signing in.
// Creating and replaying jobs do not, and deliver_webhook is the reason: an open POST /jobs
// means a stranger can make this server send a request to any URL they choose.
//
// Two kinds of caller, two proofs:
//
//   a machine (cron, another service)  Authorization: Bearer <api key>
//   a human operator                   a signed session cookie, from the password
//
// A key is wrong for the browser — it would have to be pasted into the frontend, where
// anyone can read it. A cookie is wrong for a cron. Both routes accept either.

// --------------------------------------------------------------------------
// API keys — for machines
// --------------------------------------------------------------------------

// Comma-separated in .env. Empty means no key is configured.
const API_KEYS = (process.env.API_KEYS ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

// Pre-hashed once at startup, not on every request.
const KEY_DIGESTS = API_KEYS.map(sha256);

// --------------------------------------------------------------------------
// Password — for the operator
// --------------------------------------------------------------------------

// Stored in plain text, and that is deliberate. This is a deployment secret, like the
// password already sitting inside DATABASE_URL — not a user record in a table. Hashing
// protects a password against someone reading the database it lives in, and there is no
// such database here: anyone who can read this value can read the whole .env anyway.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";

/**
 * Signs the session cookie.
 *
 * Falls back to a value generated at boot, which works but means every restart invalidates
 * every session — and with more than one API process, a cookie issued by one is rejected by
 * the others. The startup warning says so; set it in .env.
 */
const SESSION_SECRET = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");

const SESSION_COOKIE = "qf_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// --------------------------------------------------------------------------
// Exported state, for the startup warnings
// --------------------------------------------------------------------------

export const KEYS_CONFIGURED = API_KEYS.length > 0;
export const LOGIN_ENABLED = ADMIN_PASSWORD.length > 0;
export const SESSION_SECRET_SET = Boolean(process.env.SESSION_SECRET);

/**
 * True when nothing can prove anything — no keys AND no password.
 *
 * In that state the write routes stay open, so a fresh clone runs with no setup. A deploy in
 * that state is a mistake, which is what the startup warning is for.
 */
export const AUTH_DISABLED = !KEYS_CONFIGURED && !LOGIN_ENABLED;

// --------------------------------------------------------------------------
// Constant-time comparison
// --------------------------------------------------------------------------

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Compare in constant time.
 *
 * `a === b` returns as soon as two characters differ, so the time taken to answer leaks how
 * much of the secret was right — enough, over many requests, to guess it a character at a
 * time. timingSafeEqual always reads both buffers fully.
 *
 * Compared as SHA-256 digests rather than raw strings because timingSafeEqual throws unless
 * both buffers are the same length, and the length of what was submitted is itself something
 * not to react to.
 */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function isKnownKey(token: string): boolean {
  const digest = sha256(token);
  return KEY_DIGESTS.some((known) => timingSafeEqual(digest, known));
}

// --------------------------------------------------------------------------
// The session cookie
// --------------------------------------------------------------------------

/**
 * A signed token: `<expiry>.<signature>`.
 *
 * Hand-rolled rather than reaching for jsonwebtoken. A JWT is a header, a payload and a
 * signature — and here the header would name an algorithm that never varies and the payload
 * would hold one number. The whole value of a JWT is that a third party can read and verify
 * it; nothing here is a third party.
 *
 * The signature covers the expiry, so a client cannot extend its own session by editing the
 * cookie: any change makes the HMAC stop matching.
 */
function issueSession(): string {
  const expiry = String(Date.now() + SESSION_TTL_MS);
  return `${expiry}.${sign(expiry)}`;
}

function sign(value: string): string {
  return createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function isValidSession(token: string): boolean {
  const [expiry, signature] = token.split(".");
  if (!expiry || !signature) return false;

  // Signature first, then expiry. Checking expiry first would answer faster for a token
  // that is merely old than for one that is forged, which is a difference worth not having.
  if (!sameSecret(signature, sign(expiry))) return false;

  return Number(expiry) > Date.now();
}

/**
 * Read one cookie off the raw header.
 *
 * Express 5 does not parse cookies and this is the only one we set, so five lines here
 * instead of a dependency.
 */
function readCookie(req: Request, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

export function hasSession(req: Request): boolean {
  const token = readCookie(req, SESSION_COOKIE);
  return token !== "" && isValidSession(token);
}

export function setSessionCookie(req: Request, res: Response): void {
  res.cookie(SESSION_COOKIE, issueSession(), {
    // JavaScript cannot read it, so an XSS on the dashboard cannot steal the session.
    httpOnly: true,
    // Sent on top-level navigation to this site but not on cross-site POSTs — the cheap
    // half of CSRF protection for a cookie that only ever guards same-origin actions.
    sameSite: "lax",
    // HTTPS only, once there is HTTPS. Behind a proxy Express needs `trust proxy` for this
    // to be accurate, which the deployment step will set.
    secure: req.secure,
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

// --------------------------------------------------------------------------
// Login attempts
// --------------------------------------------------------------------------

/**
 * One password on a public URL is guessable given enough tries, and nothing else here slows
 * that down. A Map keyed by IP is not rate limiting for a fleet — it is per-process and
 * resets on restart — but it turns "guess forever" into "guess 5 times per 15 minutes",
 * which is the difference that matters.
 */
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; firstAt: number }>();

export function isThrottled(ip: string): boolean {
  const entry = attempts.get(ip);
  if (!entry) return false;

  if (Date.now() - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailure(ip: string): void {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

export function clearFailures(ip: string): void {
  attempts.delete(ip);
}

/** The password check itself. False when no password is configured — login is then off. */
export function isCorrectPassword(password: string): boolean {
  if (!LOGIN_ENABLED || !password) return false;
  return sameSecret(password, ADMIN_PASSWORD);
}

// --------------------------------------------------------------------------
// The guard
// --------------------------------------------------------------------------

/** Guards the routes that change something. Either proof will do. */
export function requireWrite(req: Request, res: Response, next: NextFunction): void {
  if (AUTH_DISABLED) return next();

  // A machine.
  const header = req.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (token && isKnownKey(token)) return next();

  // A logged-in human.
  if (hasSession(req)) return next();

  // Says nothing about which proof failed or what was tried, and neither secret ever
  // reaches a log. 401, not 403: the caller has not shown who it is, as opposed to being
  // known and not permitted.
  res.status(401).json({ error: "authentication required" });
}
