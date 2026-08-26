import { ReplitConnectors } from "@replit/connectors-sdk";

type EmailPayload = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  idempotencyKey?: string;
};

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
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend rejected the internal delivery: ${response.status} ${detail.slice(0, 500)}`);
  }
}

export async function sendProjectDocumentEmail(input: {
  clientName: string;
  title: string;
  markdown: string;
  jsonData: unknown;
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
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend rejected the delivery: ${response.status} ${detail.slice(0, 500)}`);
  }
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
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend rejected the welcome email: ${response.status} ${detail.slice(0, 500)}`);
  }
}