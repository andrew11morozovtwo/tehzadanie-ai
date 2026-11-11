import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Prepared for integration after an isolated PostgreSQL test database is available.
// This module has no database, environment, network or session side effects.
export const LOGIN_PURPOSE = "email_login" as const;
export const LOGIN_TTL_MS = 15 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type LoginChallenge = {
  email: string;
  tokenHash: string;
  purpose: typeof LOGIN_PURPOSE;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
};

export function normalizeLoginEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@<>"\\,;:\u0000-\u001f\u007f]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)
  ) throw new Error("Некорректный формат email");
  // Deliberately preserve dots and plus-addressing. This is not mailbox verification.
  return email;
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashLoginToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Недействительная ссылка");
  return createHash("sha256").update(token).digest("hex");
}

export function createLoginChallenge(email: string, now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("Некорректное время запроса");
  const token = newOpaqueToken();
  const challenge: LoginChallenge = {
    email: normalizeLoginEmail(email),
    tokenHash: hashLoginToken(token),
    purpose: LOGIN_PURPOSE,
    createdAt: new Date(now),
    expiresAt: new Date(now.getTime() + LOGIN_TTL_MS),
    usedAt: null,
  };
  // Only challenge is eligible for persistence; token is used solely in the email.
  return { token, challenge };
}

export function inspectLoginChallenge(
  challenge: LoginChallenge | null,
  token: string,
  email: string,
  now: Date,
): "valid" | "invalid" | "expired" | "used" {
  if (!challenge || !TOKEN_PATTERN.test(token) || !/^[a-f0-9]{64}$/.test(challenge.tokenHash)) {
    return "invalid";
  }
  let normalizedEmail: string;
  try {
    normalizedEmail = normalizeLoginEmail(email);
  } catch {
    return "invalid";
  }
  if (
    challenge.purpose !== LOGIN_PURPOSE || challenge.email !== normalizedEmail ||
    !timingSafeEqual(Buffer.from(hashLoginToken(token), "hex"), Buffer.from(challenge.tokenHash, "hex"))
  ) return "invalid";
  if (challenge.usedAt !== null) return "used";
  if (
    !Number.isFinite(now.getTime()) || !Number.isFinite(challenge.expiresAt.getTime()) ||
    challenge.expiresAt.getTime() <= now.getTime()
  ) return "expired";
  // Read-only inspection. A future repository must consume the token atomically.
  return "valid";
}

export function trustedPublicUrl(value: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || (local && url.protocol === "http:")) ||
    url.username || url.password || url.search || url.hash
  ) throw new Error("Некорректный публичный адрес приложения");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

export function buildConfirmationLink(publicUrl: string, token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Недействительная ссылка");
  const url = new URL("auth/confirm", trustedPublicUrl(publicUrl));
  // A fragment is not sent in the HTTP request or Referer.
  // The landing page clears the fragment and performs a CSRF-protected POST.
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export function validConfirmationRequest(input: {
  method: string;
  origin: string | undefined;
  publicUrl: string;
  csrfCookie: string | undefined;
  csrfHeader: string | undefined;
}): boolean {
  if (input.method !== "POST") return false;
  let expectedOrigin: string;
  try { expectedOrigin = trustedPublicUrl(input.publicUrl).origin; } catch { return false; }
  if (input.origin !== expectedOrigin) return false;
  const { csrfCookie, csrfHeader } = input;
  return Boolean(
    csrfCookie && csrfHeader &&
    TOKEN_PATTERN.test(csrfCookie) && TOKEN_PATTERN.test(csrfHeader) &&
    timingSafeEqual(Buffer.from(csrfCookie), Buffer.from(csrfHeader)),
  );
}

export function safeReturnPath(value: unknown, publicUrl: string): string {
  const base = trustedPublicUrl(publicUrl);
  const fallback = `${base.pathname}dashboard`;
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return fallback;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return fallback; }
  if (
    decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded) ||
    /%(?:25|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(decoded)
  ) return fallback;
  const target = new URL(value, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.hash) return fallback;
  return `${target.pathname}${target.search}`;
}

export function emailLoginAccess(input: {
  mailboxConfirmed: boolean;
  account: { id: number; email: string; emailVerifiedAt: Date | null } | null;
  passwordProof: { userId: number; email: string } | null;
}): "create_new" | "existing" | "mailbox_required" {
  if (!input.mailboxConfirmed) return "mailbox_required";
  if (!input.account) return "create_new";
  return "existing";
}

export function accountSwitchDecision(
  currentUserId: number | null, targetUserId: number, consent: boolean,
): "continue" | "consent_required" {
  return currentUserId !== null && currentUserId !== targetUserId && !consent
    ? "consent_required" : "continue";
}

/**
 * Pure policy only: timestamps must come from a repository transaction holding
 * email/IP locks. This is NOT an in-memory or distributed rate limiter.
 */
export function evaluateSendLimits(input: {
  now: number;
  emailSentAt: number[];
  ipSentAt: number[];
  ipMaxPerHour: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  if (!Number.isFinite(input.now) || !Number.isInteger(input.ipMaxPerHour) || input.ipMaxPerHour < 1) {
    throw new Error("Некорректные параметры лимита");
  }
  const windowMs = 3_600_000;
  const recent = (times: number[]) => times.filter(t => {
    if (!Number.isFinite(t) || t > input.now) throw new Error("Некорректное время отправки");
    return t > input.now - windowMs;
  }).sort((a, b) => a - b);
  const email = recent(input.emailSentAt);
  const ip = recent(input.ipSentAt);
  const blockedUntil = [input.now];
  if (email.length) blockedUntil.push(email[email.length - 1] + 60_000);
  if (email.length >= 5) blockedUntil.push(email[email.length - 5] + windowMs);
  if (ip.length >= input.ipMaxPerHour) blockedUntil.push(ip[ip.length - input.ipMaxPerHour] + windowMs);
  const retryAfterSeconds = Math.max(0, Math.ceil((Math.max(...blockedUntil) - input.now) / 1000));
  return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
}
