import app from "./app";
import { logger } from "./lib/logger";
import { resumePendingAudits } from "./modules/ai-audit/audit-job";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // During the authorized auth preview checks do not resume old jobs or send
  // registration/audit mail. Existing audit rows must remain unchanged.
  if (process.env.NODE_ENV === "development" && ["disabled", "preview-canary", "preview-verified"].includes(process.env.EMAIL_AUTH_MAIL_MODE ?? "")) {
    logger.info({ event: "preview_auth_mail_only" }, "Preview auth mail policy active; other mail and pending audit recovery remain disabled");
  } else {
    void resumePendingAudits().catch((err) =>
      logger.error({ err }, "AI audit recovery failed"),
    );
  }
});
