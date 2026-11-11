import assert from "node:assert/strict";
import { test } from "node:test";
import { readEmailAuthSettings } from "../src/modules/email-auth/settings";
import { createEmailAuthService } from "../src/modules/email-auth/service";
import { sendEmailVerification, sendInternalEmail } from "../src/lib/send-project-document";
import { MemoryEmailAuthRepository } from "./email-auth.fixture";

const recipient = "allowed@example.invalid";
const publicUrl = "https://canary-fixture.replit.dev/";
const env = {
  NODE_ENV: "development", EMAIL_AUTH_MAIL_MODE: "preview-canary",
  EMAIL_AUTH_PREVIEW_RECIPIENT: recipient, EMAIL_AUTH_PREVIEW_SEND_ID: "a".repeat(32),
  AUTH_PUBLIC_URL: publicUrl, REPLIT_DEV_DOMAIN: "canary-fixture.replit.dev",
  AUTH_IP_MAX_PER_HOUR: "60", AUTH_TRUST_PROXY_HOPS: "0", SESSION_SECRET: "synthetic-test-secret",
};
function fixture(options: { approved?: boolean; fails?: boolean; repository?: MemoryEmailAuthRepository; now?: Date } = {}) {
  const repository = options.repository ?? new MemoryEmailAuthRepository();
  const sent: string[] = [];
  const service = createEmailAuthService({
    repository, publicUrl, ipMaxPerHour: 60, verifyPassword: async () => false,
    clock: () => options.now ?? new Date("2026-11-05T12:00:00Z"),
    previewSendPolicy: { recipient, approved: options.approved ?? false, permitKey: "b".repeat(64) },
    mailer: { send: async msg => { sent.push(msg.text); if (options.fails) throw new Error("Mock rejection"); } },
  });
  return { repository, service, sent };
}
test("canary settings: fixed test sender, exact preview URL, explicit approval, no production fallback", () => {
  const settings = readEmailAuthSettings(env);
  assert.equal(settings.sender, "onboarding@resend.dev");
  assert.equal(settings.previewSend?.approved, false);
  for (const override of [
    { NODE_ENV: "production" }, { NODE_ENV: "test" },
    { AUTH_PUBLIC_URL: "https://other-preview.replit.dev/" },
    { AUTH_PUBLIC_URL: "https://canary-fixture.replit.dev/wrong/" },
    { EMAIL_AUTH_PREVIEW_RECIPIENT: "" }, { EMAIL_AUTH_PREVIEW_SEND_ID: "" },
    { EMAIL_AUTH_MAIL_MODE: "resend", RESEND_FROM_EMAIL: "onboarding@resend.dev" },
  ]) assert.throws(() => readEmailAuthSettings({ ...env, ...override }));
});
test("canary without approval does no SQL, creates no challenge, sends nothing", async () => {
  const f = fixture();
  assert.equal((await f.service.requestLink({ email: recipient, ipKey: "c".repeat(64) })).status, "unavailable");
  assert.equal(f.repository.calls, 0);
  assert.equal(f.sent.length, 0);
});
test("approved canary denies every other address before persistence or mail", async () => {
  const f = fixture({ approved: true });
  for (const email of ["other@example.invalid", "allowed+extra@example.invalid", "allowed@other.invalid"]) {
    assert.equal((await f.service.requestLink({ email, ipKey: "c".repeat(64) })).status, "unavailable");
  }
  assert.equal(f.repository.calls, 0);
  assert.equal(f.sent.length, 0);
});
test("one-shot permit: parallel callers and a new service after two days still produce only one mocked mail", async () => {
  const f = fixture({ approved: true });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.service.requestLink({
    email: recipient.toUpperCase(), ipKey: i.toString(16).repeat(64),
  })));
  assert.equal(results.filter(r => r.status === "accepted").length, 1);
  assert.equal(f.sent.length, 1);
  const link = new URL(f.sent[0].split("\n\n")[2]);
  assert.equal(link.origin, new URL(publicUrl).origin);
  assert.equal(link.pathname, "/auth/confirm");
  assert.equal(f.repository.state.accounts.length, 0);
  const next = fixture({ approved: true, repository: f.repository, now: new Date("2026-11-07T12:00:00Z") });
  assert.equal((await next.service.requestLink({ email: recipient, ipKey: "c".repeat(64) })).status, "unavailable");
  assert.equal(next.sent.length, 0);
});
test("failed provider result spends the permit; no automatic resend", async () => {
  const f = fixture({ approved: true, fails: true });
  const request = { email: recipient, ipKey: "c".repeat(64) };
  assert.equal((await f.service.requestLink(request)).status, "unavailable");
  assert.equal((await f.service.requestLink(request)).status, "unavailable");
  assert.equal(f.sent.length, 1);
  assert.equal(f.repository.state.challenges[0].delivery, "failed");
});
test("delivery boundary: no real credentials; blocked cases never reach provider; approved case uses a stable idempotency key", async () => {
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  let calls = 0;
  const keys: string[] = [];
  try {
    Object.assign(process.env, env, { RESEND_API_KEY: "synthetic-key-never-sent" });
    globalThis.fetch = async (_url, options) => {
      calls++;
      const body = JSON.parse(options!.body as string);
      assert.equal(body.to.length, 1);
      assert.equal(body.to[0], recipient);
      assert.equal(body.from, "onboarding@resend.dev");
      keys.push((options!.headers as Record<string, string>)["Idempotency-Key"]);
      return new Response(JSON.stringify({ id: "mock-delivery" }), { status: 200 });
    };
    const message = { to: recipient, subject: "Synthetic", text: "Synthetic", html: "<p>Synthetic</p>" };
    await assert.rejects(() => sendEmailVerification("onboarding@resend.dev", message));
    process.env.EMAIL_AUTH_PREVIEW_SEND_APPROVED = "true";
    await assert.rejects(() => sendInternalEmail({ recipient, subject: "Not a login mail", html: "<p>Blocked</p>" }));
    await assert.rejects(() => sendEmailVerification("onboarding@resend.dev", { ...message, to: "other@example.invalid" }));
    process.env.NODE_ENV = "production";
    await assert.rejects(() => sendEmailVerification("onboarding@resend.dev", message));
    assert.equal(calls, 0);
    process.env.NODE_ENV = "development";
    await sendEmailVerification("onboarding@resend.dev", message);
    await sendEmailVerification("onboarding@resend.dev", message);
    assert.equal(keys.length, 2);
    assert.equal(keys[0] === keys[1] && keys[0].length > 20, true);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});
