import bcrypt from "bcryptjs";
import { createHmac } from "node:crypto";
import { PostgresEmailAuthRepository, type AuthSqlPool } from "./postgres-repository";
import { createEmailAuthService } from "./service";
import { createEmailAuthRouter } from "./http";
import type { EmailAuthSettings } from "./settings";
import { attachVerifiedUser, clearSessionCookie, getUserId, readSignedSession, setSessionCookie } from "../../lib/auth";
import { sendEmailVerification, sendDeveloperRegistrationEmail } from "../../lib/send-project-document";
import { logger } from "../../lib/logger";

export function createEmailAuthRuntime(pool: AuthSqlPool, settings: EmailAuthSettings) {
  const service = createEmailAuthService({
    repository: new PostgresEmailAuthRepository(pool),
    mailer: { send: async message => {
      if (settings.mailMode === "disabled") throw new Error("Preview delivery is disabled");
      if (settings.mailMode === "preview-canary" && (!settings.previewSend?.approved ||
        message.to !== settings.previewSend.recipient)) throw new Error("Preview delivery is not authorized");
      await sendEmailVerification(settings.sender, message);
    } },
    verifyPassword: bcrypt.compare, publicUrl: settings.publicUrl, ipMaxPerHour: settings.ipMaxPerHour,
    previewSendPolicy: settings.previewSend && {
      recipient: settings.previewSend.recipient, approved: settings.previewSend.approved,
      permitKey: createHmac("sha256", process.env.SESSION_SECRET!)
        .update(`preview-email-permit:${settings.previewSend.permitId}`).digest("hex"),
    },
  });
  return createEmailAuthRouter({
    service, settings, ipHashKey: process.env.SESSION_SECRET!,
    onVerifiedRegistration: async user => {
      if (settings.mailMode === "disabled" || settings.mailMode === "preview-canary" || settings.mailMode === "preview-verified") return;
      try { await sendDeveloperRegistrationEmail({ name: user.name, email: user.email }); }
      catch { logger.warn({ event: "verified_registration_notification_failed" }, "Registration notification not delivered"); }
    },
    auth: { attachUser: attachVerifiedUser, clearCookie: clearSessionCookie, userId: getUserId,
      readSession: readSignedSession, setCookie: setSessionCookie },
  });
}
