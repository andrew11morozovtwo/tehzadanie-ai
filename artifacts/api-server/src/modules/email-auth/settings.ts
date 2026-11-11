import { normalizeLoginEmail, trustedPublicUrl } from "./security";

export const emailAuthEnabled = () => process.env.EMAIL_AUTH_ENABLED === "true";
export type EmailAuthSettings = {
  publicUrl: string; sender: string; ipMaxPerHour: number; trustProxyHops: number; loginPaused?: boolean;
  mailMode?: "resend" | "disabled" | "preview-canary" | "preview-verified";
  previewSend?: { recipient: string; approved: boolean; permitId: string };
};
export function readEmailAuthSettings(env: NodeJS.ProcessEnv = process.env): EmailAuthSettings {
  const publicUrl = env.AUTH_PUBLIC_URL;
  const mailMode = env.EMAIL_AUTH_MAIL_MODE ?? "resend";
  const sender = mailMode === "preview-verified" ? env.EMAIL_AUTH_FROM_EMAIL : env.EMAIL_AUTH_FROM_EMAIL ?? env.RESEND_FROM_EMAIL;
  if (env.EMAIL_AUTH_TRANSPORT && env.EMAIL_AUTH_TRANSPORT !== "connector") {
    throw new Error("Unsupported email authentication transport");
  }
  if (!["resend", "disabled", "preview-canary", "preview-verified"].includes(mailMode)) throw new Error("Unsupported email delivery mode");
  if (mailMode !== "resend" && env.NODE_ENV !== "development") {
    throw new Error("Preview delivery modes are restricted to development");
  }
  if (!publicUrl || (mailMode === "resend" && (!sender || /[\r\n]/.test(sender) || sender.includes("onboarding@resend.dev")))) {
    throw new Error("Email authentication requires a trusted public URL and verified sender");
  }
  trustedPublicUrl(publicUrl);
  let previewSend: EmailAuthSettings["previewSend"];
  if (mailMode === "preview-canary" || mailMode === "preview-verified") {
    if (!env.REPLIT_DEV_DOMAIN || publicUrl !== `https://${env.REPLIT_DEV_DOMAIN}/`) {
      throw new Error("Email links must target the current preview origin");
    }
  }
  if (mailMode === "preview-verified") {
    if (!sender || normalizeLoginEmail(sender) !== sender || sender.endsWith("@resend.dev")) {
      throw new Error("EMAIL_AUTH_FROM_EMAIL must be a plain verified sender address");
    }
  }
  if (mailMode === "preview-canary") {
    const recipient = normalizeLoginEmail(env.EMAIL_AUTH_PREVIEW_RECIPIENT ?? "");
    const permitId = env.EMAIL_AUTH_PREVIEW_SEND_ID;
    if (!permitId || !/^[a-f0-9]{32}$/.test(permitId)) throw new Error("Canary requires a fixed one-shot permit");
    previewSend = { recipient, permitId, approved: env.EMAIL_AUTH_PREVIEW_SEND_APPROVED === "true" };
  }
  if (mailMode === "resend" && !/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(sender!)) {
    throw new Error("Email authentication sender must be a plain verified address");
  }
  const ipMaxPerHour = Number(env.AUTH_IP_MAX_PER_HOUR);
  const trustProxyHops = Number(env.AUTH_TRUST_PROXY_HOPS);
  if (!env.AUTH_IP_MAX_PER_HOUR || !Number.isInteger(ipMaxPerHour) || ipMaxPerHour < 5) {
    throw new Error("AUTH_IP_MAX_PER_HOUR must be explicitly configured");
  }
  if (env.AUTH_TRUST_PROXY_HOPS === undefined || !Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    throw new Error("AUTH_TRUST_PROXY_HOPS must be explicitly configured");
  }
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
  return { publicUrl, sender: mailMode === "preview-canary" ? "onboarding@resend.dev" : sender ?? "", ipMaxPerHour, trustProxyHops,
    loginPaused: env.EMAIL_AUTH_LOGIN_PAUSED === "true",
    mailMode: mailMode as EmailAuthSettings["mailMode"], previewSend };
}
