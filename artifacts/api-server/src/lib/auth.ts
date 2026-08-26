import type { Request, Response } from "express";
import jwt from "jsonwebtoken";

const COOKIE_NAME = "requirements_session";

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) {
    throw new Error("SESSION_SECRET must be configured");
  }
  return value;
}

export function getUserId(req: Request): number | null {
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

export function setSessionCookie(res: Response, userId: number): void {
  const token = jwt.sign({ userId }, secret(), { expiresIn: "30d" });
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