import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { retryAuditForSession } from "./audit-job";

const router: IRouter = Router();

function isAuthorized(req: Request): boolean {
  const configured = process.env.ADMIN_AUDIT_TOKEN;
  const authorization = req.header("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!configured || !token) return false;
  const expected = Buffer.from(configured);
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

router.post("/internal/audit/sessions/:sessionId/retry", async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(404).end();
    return;
  }
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    res.status(400).json({ error: "Некорректная сессия" });
    return;
  }
  const queued = await retryAuditForSession(sessionId);
  if (!queued) {
    res.status(409).json({ error: "Аудит недоступен или уже завершён для текущей версии ТЗ" });
    return;
  }
  res.status(202).json({ status: "queued" });
});

export default router;