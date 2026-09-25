import { ReplitConnectors } from "@replit/connectors-sdk";

type EmailPayload = {
  from: string;
  to: string[];
  subject: string;
  html: string;
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

async function sendEmail(payload: EmailPayload): Promise<Response> {
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