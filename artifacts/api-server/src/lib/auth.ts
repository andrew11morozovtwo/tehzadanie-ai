import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { emailAuthEnabled } from "../modules/email-auth/settings";

const COOKIE_NAME = "requirements_session";
const verifiedUsers = new WeakMap<Request, number>();

export function attachVerifiedUser(req: Request, userId: number): void {
  verifiedUsers.set(req, userId);
}

export function readSignedSession(req: Request): { userId: number; sid?: string } | null {
  const token = req.cookies?.[COOKIE_NAME];
  if (typeof token !== "string") return null;
  try {
    const value = jwt.verify(token, secret(), { algorithms: ["HS256"] });
    if (typeof value !== "object" || !Number.isSafeInteger(value.userId) || value.userId < 1) return null;
    return { userId: value.userId, sid: typeof value.sid === "string" ? value.sid : undefined };
  } catch { return null; }
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) {
    throw new Error("SESSION_SECRET must be configured");
  }
  return value;
}

export function getUserId(req: Request): number | null {
  // A legacy signed JWT is insufficient after the explicitly approved rollout.
  if (emailAuthEnabled()) return verifiedUsers.get(req) ?? null;
  const token = req.cookies?.[COOKIE_NAME];
  if (typeof token !== "string") return null;

  try {
    const decoded = jwt.verify(token, secret());
    return typeof decoded === "object" && typeof decoded.userId === "number"
      ? decoded.userId
      : null;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, userId: number, sid?: string): void {
  const token = jwt.sign({ userId, ...(sid ? { sid } : {}) }, secret(), { expiresIn: "30d" });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}