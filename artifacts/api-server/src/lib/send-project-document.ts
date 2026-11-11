import { ReplitConnectors } from "@replit/connectors-sdk";
import { createHash } from "node:crypto";
import { readEmailAuthSettings } from "../modules/email-auth/settings";
import { normalizeLoginEmail } from "../modules/email-auth/security";

type EmailPayload = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
  idempotencyKey?: string;
};

export class EmailDeliveryError extends Error {
  constructor(
    public readonly status: number,
    public readonly providerCode: string | null,
  ) {
    super(`Email provider rejected the request (${status}${providerCode ? `: ${providerCode}` : ""})`);
    this.name = "EmailDeliveryError";
  }
}

async function ensureDelivered(response: Response): Promise<void> {
  if (response.ok) return;
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "name" in body &&
      typeof body.name === "string" &&
      /^[a-z_]{1,60}$/.test(body.name)
    ) {
      code = body.name;
    }
  } catch {
    // The response body may not be JSON. Never log it: it can include personal data.
  }
  throw new EmailDeliveryError(response.status, code);
}

function toHtml(markdown: string): string {
  return markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br />");
}

async function sendEmail(payload: EmailPayload, purpose: "login" | "other" = "other"): Promise<Response> {
  if (process.env.EMAIL_AUTH_MAIL_MODE === "preview-verified") {
    const settings = readEmailAuthSettings();
    if (purpose !== "login" || payload.from !== `ТехЗадание.AI <${settings.sender}>` || payload.to.length !== 1) {
      throw new Error("Only preview login mail is permitted");
    }
    normalizeLoginEmail(payload.to[0]);
    // Use the exact connected Resend account whose domain was verified, not a
    // possibly unrelated legacy RESEND_API_KEY. No automatic transport fallback.
    const connectors = new ReplitConnectors();
    return connectors.proxy("resend", "/emails", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  // While preparing the one-mail preview, other mail paths (including TZ and
  // registration notifications) must not bypass the same recipient/permit gate.
  if (process.env.EMAIL_AUTH_MAIL_MODE === "preview-canary") {
    const settings = readEmailAuthSettings();
    const preview = settings.previewSend;
    const expectedKey = preview && `email-auth-preview-${createHash("sha256").update(preview.permitId).digest("hex")}`;
    if (!preview?.approved || payload.from !== "onboarding@resend.dev" ||
      payload.to.length !== 1 || normalizeLoginEmail(payload.to[0]) !== preview.recipient ||
      payload.idempotencyKey !== expectedKey) {
      throw new Error("Only the authorized preview login mail is permitted");
    }
  }
  if (purpose === "login" && process.env.EMAIL_AUTH_TRANSPORT === "connector") {
    const settings = readEmailAuthSettings();
    if (payload.from !== `ТехЗадание.AI <${settings.sender}>`) throw new Error("Login sender does not match configuration");
    const connectors = new ReplitConnectors();
    return connectors.proxy("resend", "/emails", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    return fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(payload.idempotencyKey ? { "Idempotency-Key": payload.idempotencyKey } : {}),
      },
      body: JSON.stringify(payload),
    });
  }

  const connectors = new ReplitConnectors();
  return connectors.proxy("resend", "/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(payload.idempotencyKey ? { "Idempotency-Key": payload.idempotencyKey } : {}),
    },
    body: JSON.stringify(payload),
  });
}

function senderAddress(): string {
  return process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
}

/** Test sender is allowed only by the explicit development one-recipient policy. */
export async function sendEmailVerification(
  from: string,
  message: { to: string; subject: string; text: string; html: string },
): Promise<void> {
  let idempotencyKey: string | undefined;
  if (from === "onboarding@resend.dev") {
    const settings = readEmailAuthSettings();
    if (settings.mailMode !== "preview-canary" || !settings.previewSend?.approved ||
      normalizeLoginEmail(message.to) !== settings.previewSend.recipient) {
      throw new Error("Preview mail is not authorized");
    }
    idempotencyKey = `email-auth-preview-${createHash("sha256").update(settings.previewSend.permitId).digest("hex")}`;
  } else if (!from || /[\r\n]/.test(from) || from.toLowerCase().includes("onboarding@resend.dev")) {
    throw new Error("Verified sender is required");
  }
  if (process.env.EMAIL_AUTH_MAIL_MODE === "preview-verified" || process.env.EMAIL_AUTH_TRANSPORT === "connector") {
    const settings = readEmailAuthSettings();
    if (from !== settings.sender) throw new Error("Preview sender does not match the approved configuration");
    from = `ТехЗадание.AI <${settings.sender}>`;
  }
  const response = await sendEmail({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text, idempotencyKey }, "login");
  await ensureDelivered(response);
}

export async function sendInternalEmail(input: {
  recipient: string;
  subject: string;
  html: string;
  idempotencyKey?: string;
}): Promise<void> {
  const response = await sendEmail({
    from: senderAddress(),
    to: [input.recipient],
    subject: input.subject,
    html: input.html,
    idempotencyKey: input.idempotencyKey,
  });
  await ensureDelivered(response);
}

export async function sendDeveloperRegistrationEmail(input: {
  name: string;
  email: string;
}): Promise<void> {
  const recipient = process.env.DEVELOPER_EMAIL;
  if (!recipient) {
    throw new Error("DEVELOPER_EMAIL must be configured before notifying developers of registrations");
  }

  await sendInternalEmail({
    recipient,
    subject: "Новая регистрация в ТехЗадание.AI",
    html: `<p>Зарегистрирован новый пользователь.</p><p>Имя: <strong>${toHtml(input.name)}</strong></p><p>Email: <strong>${toHtml(input.email)}</strong></p>`,
  });
}

export async function sendProjectDocumentEmail(input: {
  clientName: string;
  title: string;
  markdown: string;
  jsonData: unknown;
  idempotencyKey: string;
}): Promise<void> {
  const recipient = process.env.DEVELOPER_EMAIL;
  if (!recipient) {
    throw new Error("DEVELOPER_EMAIL must be configured before sending a technical brief");
  }

  const response = await sendEmail({
    from: senderAddress(),
    to: [recipient],
    subject: `Новое ТЗ от ${input.clientName} — ${input.title}`,
    html: `${toHtml(input.markdown)}<hr /><pre>${JSON.stringify(input.jsonData, null, 2)}</pre>`,
    idempotencyKey: input.idempotencyKey,
  });

  await ensureDelivered(response);
}

export async function sendWelcomeEmail(input: {
  name: string;
  email: string;
  password: string;
}): Promise<void> {
  const response = await sendEmail({
    from: senderAddress(),
    to: [input.email],
    subject: "Доступ к ТехЗадание.AI",
    html: `<p>Здравствуйте, ${input.name}.</p><p>Ваш временный пароль: <strong>${input.password}</strong></p><p>Сохраните его в надежном месте. Он понадобится для повторного входа.</p>`,
  });
  await ensureDelivered(response);
}