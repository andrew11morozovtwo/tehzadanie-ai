import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { readEmailAuthSettings } from "../src/modules/email-auth/settings";
import { sendEmailVerification, sendInternalEmail } from "../src/lib/send-project-document";
import { createEmailAuthService } from "../src/modules/email-auth/service";
import { MemoryEmailAuthRepository } from "./email-auth.fixture";

const env = {
  NODE_ENV: "development", EMAIL_AUTH_MAIL_MODE: "preview-verified",
  EMAIL_AUTH_FROM_EMAIL: "login@sender.example", AUTH_PUBLIC_URL: "https://verified-test.replit.dev/",
  REPLIT_DEV_DOMAIN: "verified-test.replit.dev", AUTH_IP_MAX_PER_HOUR: "60",
  AUTH_TRUST_PROXY_HOPS: "0", SESSION_SECRET: "synthetic-secret",
};

test("verified preview: no recipient allowlist; requires dev, exact public URL and explicit sender", () => {
  const settings = readEmailAuthSettings(env);
  assert.equal(settings.sender, env.EMAIL_AUTH_FROM_EMAIL);
  assert.equal(settings.previewSend, undefined);
  for (const override of [
    { NODE_ENV: "production" }, { NODE_ENV: "test" },
    { AUTH_PUBLIC_URL: "https://wrong.replit.dev/" }, { EMAIL_AUTH_FROM_EMAIL: "" },
    { EMAIL_AUTH_FROM_EMAIL: "onboarding@resend.dev" }, { EMAIL_AUTH_FROM_EMAIL: "bad\r\n@sender.example" },
  ]) assert.throws(() => readEmailAuthSettings({ ...env, ...override }));
});

test("verified preview: sends only login mail via connected Resend for different recipients; blocks other mail and mismatched sender", async () => {
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  const sent: { from: string; to: string[] }[] = [];
  const proxy = mock.method(ReplitConnectors.prototype, "proxy", async (name: string, path: string, options: { body: string }) => {
    assert.equal(name, "resend");
    assert.equal(path, "/emails");
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: "mock-only" }), { status: 200 });
  });
  try {
    Object.assign(process.env, env, { RESEND_API_KEY: "mock-legacy-key-not-to-use" });
    globalThis.fetch = async () => { throw new Error("Must not use legacy key or any real network"); };
    for (const to of ["first@example.invalid", "second@example.invalid"]) {
      await sendEmailVerification(env.EMAIL_AUTH_FROM_EMAIL, { to, subject: "Mock login", html: "<p>Mock</p>", text: "Mock" });
    }
    assert.equal(sent.length, 2);
    assert.equal(sent[0].from, "ТехЗадание.AI <login@sender.example>");
    assert.notEqual(sent[0].to[0], sent[1].to[0]);
    await assert.rejects(() => sendInternalEmail({ recipient: "first@example.invalid", subject: "Not login", html: "<p>Blocked</p>" }));
    await assert.rejects(() => sendEmailVerification("other@sender.example", {
      to: "first@example.invalid", subject: "Blocked", html: "", text: "",
    }));
    process.env.NODE_ENV = "production";
    await assert.rejects(() => sendEmailVerification(env.EMAIL_AUTH_FROM_EMAIL, {
      to: "first@example.invalid", subject: "Blocked", html: "", text: "",
    }));
    assert.equal(sent.length, 2);
  } finally {
    proxy.mock.restore();
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});

test("normal persistent email/IP cooldown still applies without the one-shot preview permit", async () => {
  const sent: string[] = [];
  const service = createEmailAuthService({
    repository: new MemoryEmailAuthRepository(), publicUrl: env.AUTH_PUBLIC_URL, ipMaxPerHour: 60,
    verifyPassword: async () => false, mailer: { send: async msg => { sent.push(msg.to); } },
  });
  const ipKey = "d".repeat(64);
  assert.equal((await service.requestLink({ email: "first@example.invalid", ipKey })).status, "accepted");
  assert.equal((await service.requestLink({ email: "second@example.invalid", ipKey })).status, "accepted");
  assert.equal((await service.requestLink({ email: "first@example.invalid", ipKey })).status, "limited");
  assert.equal(sent.length, 2);
});

test("production login uses the verified connector and its own sender, not preview mode or legacy mail settings", async () => {
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  const release = {
    ...env, NODE_ENV: "production", EMAIL_AUTH_MAIL_MODE: "resend",
    EMAIL_AUTH_TRANSPORT: "connector", AUTH_PUBLIC_URL: "https://release.example/",
    RESEND_FROM_EMAIL: "legacy@other.example", RESEND_API_KEY: "mock-never-use",
  };
  const sent: { from: string; text: string }[] = [];
  const proxy = mock.method(ReplitConnectors.prototype, "proxy", async (_name: string, _path: string, options: { body: string }) => {
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: "mock" }), { status: 200 });
  });
  try {
    Object.assign(process.env, release);
    globalThis.fetch = async () => { throw new Error("Unexpected legacy transport"); };
    const settings = readEmailAuthSettings(release);
    assert.equal(settings.sender, env.EMAIL_AUTH_FROM_EMAIL);
    assert.equal(settings.previewSend, undefined);
    await sendEmailVerification(settings.sender, {
      to: "synthetic@example.invalid", subject: "Mock", html: "", text: "https://release.example/auth/confirm",
    });
    assert.equal(sent[0].from, "ТехЗадание.AI <login@sender.example>");
    assert.equal(sent.length, 1);
    assert.equal(process.env.RESEND_FROM_EMAIL, "legacy@other.example");
    assert.throws(() => readEmailAuthSettings({ ...release, EMAIL_AUTH_MAIL_MODE: "preview-verified" }));
    assert.throws(() => readEmailAuthSettings({ ...release, EMAIL_AUTH_TRANSPORT: "unknown" }));
  } finally {
    proxy.mock.restore();
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});
