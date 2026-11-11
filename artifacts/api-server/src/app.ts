import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { emailAuthEnabled, readEmailAuthSettings } from "./modules/email-auth/settings";
import { createEmailAuthRuntime } from "./modules/email-auth/runtime";

const app: Express = express();
const slowRequestMs = 3_000;

app.use(
  pinoHttp({
    logger,
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "silent";
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((req, res, next) => {
  const startedAt = performance.now();
  res.on("finish", () => {
    const responseTime = Math.round(performance.now() - startedAt);
    if (res.statusCode < 400 && responseTime >= slowRequestMs) {
      logger.warn(
        {
          method: req.method,
          url: req.url.split("?")[0],
          statusCode: res.statusCode,
          responseTime,
        },
        "Slow API request",
      );
    }
  });
  next();
});
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Off by default. No new schema queries, mail or session changes in the old mode.
// Enable ONLY after a separately approved migration, backup and mail readiness check.
if (emailAuthEnabled()) {
  const settings = readEmailAuthSettings();
  app.set("trust proxy", settings.trustProxyHops);
  app.use("/api", createEmailAuthRuntime(pool, settings));
}
app.use("/api", router);

export default app;
