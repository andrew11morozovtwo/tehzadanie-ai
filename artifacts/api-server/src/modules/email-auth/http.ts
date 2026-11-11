import { createHmac } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { createEmailAuthService } from "./service";
import type { EmailAuthSettings } from "./settings";
import { newOpaqueToken, validConfirmationRequest } from "./security";

type Service = ReturnType<typeof createEmailAuthService>;
type HttpAuth = {
  readSession(req: Request): { userId: number; sid?: string } | null;
  attachUser(req: Request, userId: number): void;
  userId(req: Request): number | null;
  setCookie(res: Response, userId: number, sid: string): void;
  clearCookie(res: Response): void;
};

/** Injectable HTTP integration; no DB, JWT secret, mail provider or flags at import time. */
export function createEmailAuthRouter(options: {
  service: Service; settings: EmailAuthSettings; auth: HttpAuth; ipHashKey: string;
  onVerifiedRegistration?: (user: { id: number; name: string; email: string }) => Promise<void>;
}) {
  const { service, settings, auth } = options;
  const router = Router();
  const secure = new URL(settings.publicUrl).protocol === "https:";
  const csrfCookie = secure ? "__Host-requirements_csrf" : "requirements_csrf";
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !validConfirmationRequest({
      method: "POST", origin: req.get("origin"), publicUrl: settings.publicUrl,
      csrfCookie: req.cookies?.[csrfCookie], csrfHeader: req.get("X-CSRF-Token"),
    })) {
      res.status(403).json({ status: "forbidden", error: "Обновите страницу и повторите действие" });
      return;
    }
    next();
  });
  router.use(async (req, _res, next) => {
    try {
      const signed = auth.readSession(req);
      if (signed?.sid) {
        const userId = await service.sessionUserId(signed.sid);
        if (userId !== null && userId === signed.userId) auth.attachUser(req, userId);
      }
      next();
    } catch {
      // Do not fall back to legacy JWT verification if the session store fails.
      next();
    }
  });
  router.get("/auth/email/csrf", (req, res) => {
    if (req.get("sec-fetch-site") === "cross-site") { res.sendStatus(403); return; }
    const previous = req.cookies?.[csrfCookie];
    // Reuse a valid host-only token so another tab does not invalidate this tab.
    const csrf = typeof previous === "string" && /^[A-Za-z0-9_-]{43}$/.test(previous) ? previous : newOpaqueToken();
    res.cookie(csrfCookie, csrf, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 30 * 60_000 });
    res.json({ csrf_token: csrf });
  });
  router.use(["/auth/email/request", "/auth/email/inspect", "/auth/email/confirm"], (_req, res, next) => {
    if (settings.loginPaused) {
      res.status(503).json({ status: "unavailable", error: "Новые входы временно приостановлены. Уже подтверждённые сессии продолжают работать." });
      return;
    }
    next();
  });
  router.post("/auth/email/request", async (req, res) => {
    if (settings.mailMode === "disabled") {
      res.status(503).json({ status: "unavailable", error: "Новый вход включён в preview, но настоящая отправка писем пока отключена. Сначала нужно согласовать отправителя Resend." });
      return;
    }
    if (settings.mailMode === "preview-canary" && !settings.previewSend?.approved) {
      res.status(503).json({ status: "unavailable", error: "Проверка письма подготовлена. Отправка ожидает отдельного подтверждения владельца." });
      return;
    }
    if (typeof req.body?.email !== "string") {
      res.status(400).json({ status: "invalid_email", error: "Введите корректный email" }); return;
    }
    const ipKey = createHmac("sha256", options.ipHashKey).update(`email-auth-ip:v1:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`).digest("hex");
    const result = await service.requestLink({ email: req.body.email, ipKey });
    if (result.status === "limited") {
      res.setHeader("Retry-After", result.retryAfterSeconds);
      res.status(429).json({ ...result, retry_after_seconds: result.retryAfterSeconds, error: "Слишком часто. Подождите перед повторной отправкой." });
    } else if (result.status === "invalid_email") {
      res.status(400).json({ ...result, error: "Введите корректный email" });
    } else if (result.status === "unavailable") {
      res.status(503).json({ ...result, error: "Отправка временно недоступна. Попробуйте позднее." });
    } else res.status(202).json(result);
  });
  router.post("/auth/email/inspect", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const result = await service.previewLink(token);
    res.status(result.status === "unavailable" ? 503 : 200).json(result);
  });
  router.post("/auth/email/confirm", async (req, res) => {
    const body = req.body ?? {};
    if (
      typeof body.token !== "string" || (body.password !== undefined && (typeof body.password !== "string" || body.password.length > 1024)) ||
      (body.name !== undefined && typeof body.name !== "string")
    ) { res.status(400).json({ status: "invalid", error: "Проверьте данные подтверждения" }); return; }
    const result = await service.confirm({
      token: body.token, name: body.name, password: body.password,
      currentUserId: auth.userId(req), switchConsent: body.switch_consent === true,
      currentSessionId: auth.userId(req) === null ? undefined : auth.readSession(req)?.sid,
      returnTo: typeof body.return_to === "string" ? body.return_to : undefined,
      request: { method: req.method, origin: req.get("origin"), csrfCookie: req.cookies?.[csrfCookie], csrfHeader: req.get("X-CSRF-Token") },
    });
    if (result.status === "confirmed") {
      // Cookie signing happens after COMMIT, never before it.
      auth.setCookie(res, result.user.id, result.sessionId);
      if (result.isNew && options.onVerifiedRegistration) {
        // Notification failures must not undo an already committed verified login.
        void options.onVerifiedRegistration(result.user).catch(() => {});
      }
      res.json({ status: result.status, user: result.user, return_to: result.returnTo });
      return;
    }
    const messages: Record<string, string> = {
      invalid: "Ссылка недействительна. Запросите новую.", expired: "Срок ссылки истёк. Запросите новую.",
      used: "Ссылка уже использована. Запросите новую.", name_required: "Введите имя от 1 до 120 символов.",
      consent_required: "Открыт другой аккаунт. Подтвердите переключение.",
      legacy_attempts_exhausted: "Лимит попыток исчерпан. Запросите новую ссылку. Автоматическое восстановление старого аккаунта недоступно.",
      forbidden: "Обновите страницу и повторите подтверждение.",
      unavailable: "Вход временно недоступен. Попробуйте позднее.",
    };
    const code = result.status === "unavailable" ? 503 : result.status === "forbidden" ? 403 :
      result.status === "consent_required" ? 409 : ["expired", "used"].includes(result.status) ? 410 : 400;
    res.status(code).json({ ...result, error: "message" in result ? result.message : messages[result.status] });
  });
  router.post("/auth/logout", async (req, res) => {
    const signed = auth.readSession(req);
    if (signed?.sid && !await service.revokeSession(signed.sid)) {
      res.status(503).json({ error: "Не удалось завершить сессию на сервере. Повторите выход." }); return;
    }
    auth.clearCookie(res);
    res.sendStatus(204);
  });
  for (const path of ["/auth/register", "/auth/login"]) {
    router.post(path, (_req, res) => {
      res.status(409).json({ status: "email_confirmation_required", error: "Введите email и войдите по ссылке из письма. Пароль не нужен." });
    });
  }
  // This previously anonymous paid operation is protected in the new mode.
  router.use("/transcribe", (req, res, next) => {
    if (!auth.userId(req)) { res.status(401).json({ error: "Требуется вход" }); return; }
    next();
  });
  return router;
}
