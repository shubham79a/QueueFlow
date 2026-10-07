import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Authentication for write operations.
// Reads stay public; writes require an API key or operator session.

// API keys for machine clients.
const API_KEYS = (process.env.API_KEYS ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

// Pre-hash keys once at startup.
const KEY_DIGESTS = API_KEYS.map(sha256);

// Operator password for browser login.
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD ?? "").trim();

// Session signing configuration.
const SESSION_SECRET = (process.env.SESSION_SECRET ?? randomBytes(32).toString("hex")).trim();

const SESSION_COOKIE = "qf_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Authentication configuration state.
export const KEYS_CONFIGURED = API_KEYS.length > 0;
export const LOGIN_ENABLED = ADMIN_PASSWORD.length > 0;
export const SESSION_SECRET_SET = Boolean(process.env.SESSION_SECRET);

export const AUTH_DISABLED = !KEYS_CONFIGURED && !LOGIN_ENABLED;

// Compare secrets in constant time.
function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function isKnownKey(token: string): boolean {
  const digest = sha256(token);
  return KEY_DIGESTS.some((known) => timingSafeEqual(digest, known));
}

// Create and verify signed session cookies.
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

  if (!sameSecret(signature, sign(expiry))) return false;

  return Number(expiry) > Date.now();
}

// Read the session cookie.
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
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

// Limit repeated login attempts per IP.
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

// Check whether the password is correct.
export function isCorrectPassword(password: string): boolean {
  if (!LOGIN_ENABLED || !password) return false;
  return sameSecret(password, ADMIN_PASSWORD);
}

// Require API-key or session authentication for write routes.
export function requireWrite(req: Request, res: Response, next: NextFunction): void {
  if (AUTH_DISABLED) return next();

  const header = req.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (token && isKnownKey(token)) return next();

  if (hasSession(req)) return next();

  res.status(401).json({ error: "authentication required" });
}