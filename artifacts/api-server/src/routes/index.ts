import { Router, type IRouter } from "express";
import healthRouter from "./health";
import requirementsRouter from "./requirements";
import auditRouter from "../modules/ai-audit/audit-routes";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requirementsRouter);
router.use(auditRouter);

export default router;
