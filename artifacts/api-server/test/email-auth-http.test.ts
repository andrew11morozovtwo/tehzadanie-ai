import assert from "node:assert/strict";
import { test } from "node:test";
import express, { type Request } from "express";
import cookieParser from "cookie-parser";
import { createEmailAuthRouter } from "../src/modules/email-auth/http";
import { createEmailAuthService } from "../src/modules/email-auth/service";
import { readEmailAuthSettings, emailAuthEnabled } from "../src/modules/email-auth/settings";
import { MemoryEmailAuthRepository } from "./email-auth.fixture";
import { PostgresEmailAuthRepository, type AuthSqlClient } from "../src/modules/email-auth/postgres-repository";
import { hashLoginToken, newOpaqueToken } from "../src/modules/email-auth/security";
import { attachVerifiedUser, getUserId, readSignedSession, setSessionCookie } from "../src/lib/auth";
import type { Response } from "express";

async function httpFixture(loginPaused = false) {
  const repository = new MemoryEmailAuthRepository();
  const messages: string[] = [];
  const users = new WeakMap<Request, number>();
  const service = createEmailAuthService({
    repository, publicUrl: "https://app.example.com/", ipMaxPerHour: 20,
    mailer: { send: async msg => { messages.push(msg.text); } },
    verifyPassword: async (plain, hash) => plain === "test-password" && hash === "test-hash",
  });
  const app = express();
  app.use(express.json(), cookieParser());
  app.use(createEmailAuthRouter({
    service, ipHashKey: "test-only-ip-key",
    settings: { publicUrl: "https://app.example.com/", sender: "sender@example.com", ipMaxPerHour: 20, trustProxyHops: 0, loginPaused },
    auth: {
      readSession: req => req.cookies.fixture_sid ? { userId: Number(req.cookies.fixture_uid), sid: req.cookies.fixture_sid } : null,
      attachUser: (req, id) => { users.set(req, id); },
      userId: req => users.get(req) ?? null,
      setCookie: (res, id, sid) => { res.cookie("fixture_sid", sid); res.cookie("fixture_uid", String(id)); },
      clearCookie: res => { res.clearCookie("fixture_sid"); res.clearCookie("fixture_uid"); },
    },
  }));
  app.get("/private", (req, res) => users.has(req) ? res.json({ id: users.get(req) }) : res.sendStatus(401));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const handle = app.listen(0, "127.0.0.1", () => resolve(handle));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const base = `http://127.0.0.1:${address.port}`;
  const csrfResponse = await fetch(`${base}/auth/email/csrf`);
  const csrf = (await csrfResponse.json()).csrf_token as string;
  const csrfCookie = csrfResponse.headers.get("set-cookie")!.split(";")[0];
  const request = (path: string, body: unknown, session = "") => fetch(`${base}${path}`, {
    method: "POST", headers: {
      "content-type": "application/json", origin: "https://app.example.com",
      "x-csrf-token": csrf, cookie: `${csrfCookie}${session ? `; ${session}` : ""}`,
    }, body: JSON.stringify(body),
  });
  const token = () => new URLSearchParams(new URL(messages.at(-1)!.split("\n\n")[2]).hash.slice(1)).get("token")!;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  };
  return { base, request, token, repository, close, csrfResponse, csrfCookie, messages };
}

test("HTTP: CSRF and GET do not create an account; confirmation issues cookie after commit; copied session is revoked", async () => {
  const f = await httpFixture();
  try {
    assert.match(f.csrfResponse.headers.get("set-cookie")!, /__Host-.*HttpOnly.*Secure.*SameSite=Strict/i);
    assert.equal(f.csrfResponse.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${f.base}/auth/email/confirm`)).status, 404);
    const denied = await fetch(`${f.base}/auth/email/request`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "new@example.com" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(f.messages.length, 0);
    assert.equal((await f.request("/auth/email/request", { email: "new@example.com" })).status, 202);
    assert.equal(f.repository.state.accounts.length, 0);
    const inspect = await (await f.request("/auth/email/inspect", { token: f.token() })).json();
    assert.equal(inspect.requires_name, false);
    assert.equal(inspect.requires_legacy_password, false);
    assert.equal(inspect.email, "n***@example.com");
    assert.equal(f.repository.state.challenges[0].usedAt, null);
    const response = await f.request("/auth/email/confirm", { token: f.token(), switch_consent: false, currentUserId: 999 });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "confirmed");
    assert.equal(result.sessionId, undefined);
    const sessionCookie = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    assert.equal((await fetch(`${f.base}/private`, { headers: { cookie: sessionCookie } })).status, 200);
    assert.equal((await f.request("/auth/logout", {}, sessionCookie)).status, 204);
    assert.equal((await fetch(`${f.base}/private`, { headers: { cookie: sessionCookie } })).status, 401);
  } finally { await f.close(); }
});
test("HTTP: legacy account uses only its link; old password endpoints remain blocked", async () => {
  const f = await httpFixture();
  try {
    f.repository.state.accounts.push({ id: 42, name: "Старый", email: "old@example.com", passwordHash: "test-hash", emailVerifiedAt: null });
    assert.equal((await f.request("/auth/email/request", { email: "old@example.com" })).status, 202);
    for (const path of ["/auth/login", "/auth/register"]) {
      assert.equal((await f.request(path, { email: "old@example.com", password: "test-password" })).status, 409);
    }
    const body = { token: f.token(), switch_consent: false };
    assert.equal((await fetch(`${f.base}/auth/email/confirm`)).status, 404);
    assert.equal(f.repository.state.accounts[0].emailVerifiedAt, null);
    const ok = await f.request("/auth/email/confirm", body);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).user.id, 42);
    assert.equal(f.repository.state.accounts.length, 1);
    assert.equal(f.repository.state.accounts[0].passwordHash, "test-hash");
  } finally { await f.close(); }
});
test("HTTP: failed persistence never issues a login cookie; transcribe requires authentication", async () => {
  const f = await httpFixture();
  try {
    await f.request("/auth/email/request", { email: "new@example.com" });
    f.repository.failSessionInsert = true;
    const response = await f.request("/auth/email/confirm", { token: f.token(), name: "Тест", switch_consent: false });
    assert.equal(response.status, 503);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(f.repository.state.accounts.length, 0);
    assert.equal((await f.request("/transcribe", {})).status, 401);
  } finally { await f.close(); }
});
test("settings: feature off by default and activation requires explicit safe mail/URL/proxy settings", () => {
  assert.equal(emailAuthEnabled(), false);
  assert.throws(() => readEmailAuthSettings({}));
  const env = { AUTH_PUBLIC_URL: "https://app.example.com/", RESEND_FROM_EMAIL: "sender@example.com",
    AUTH_IP_MAX_PER_HOUR: "60", AUTH_TRUST_PROXY_HOPS: "0", SESSION_SECRET: "test-only" };
  assert.equal(readEmailAuthSettings(env).ipMaxPerHour, 60);
  assert.throws(() => readEmailAuthSettings({ ...env, RESEND_FROM_EMAIL: "onboarding@resend.dev" }));
  assert.throws(() => readEmailAuthSettings({ ...env, AUTH_PUBLIC_URL: "http://public.example.com" }));
  assert.throws(() => readEmailAuthSettings({ ...env, EMAIL_AUTH_MAIL_MODE: "disabled", NODE_ENV: "production" }));
  assert.equal(readEmailAuthSettings({
    ...env, RESEND_FROM_EMAIL: undefined, EMAIL_AUTH_MAIL_MODE: "disabled", NODE_ENV: "development",
  }).mailMode, "disabled");
});
test("PostgreSQL adapter: construction executes no SQL; thrown work rolls back and releases; all data stays parameterized", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  let released = false;
  const client: AuthSqlClient = {
    query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; },
    release: () => { released = true; },
  };
  const repo = new PostgresEmailAuthRepository({ connect: async () => client, query: client.query });
  assert.equal(calls.length, 0);
  await assert.rejects(repo.transaction(async tx => {
    await tx.lockRequestScope("private@example.com", "synthetic-ip-key");
    await tx.markEmailVerified(42, new Date("2026-11-05T12:00:00Z"));
    throw new Error("test rollback");
  }));
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1)!.sql, "ROLLBACK");
  assert.equal(calls.some(c => c.sql.includes("private@example.com")), false);
  assert.ok(calls.some(c => c.sql.includes("COALESCE(email_verified_at")));
  assert.ok(calls.some(c => c.values?.includes("email-auth:email:private@example.com")));
  assert.equal(released, true);
});
test("PostgreSQL adapter: matching email duplicates fail rather than silently picking an account", async () => {
  const repo = new PostgresEmailAuthRepository({
    connect: async () => { throw new Error("Not used"); },
    query: async () => ({ rows: [{ id: 1 }, { id: 2 }] }),
  });
  await assert.rejects(repo.readAccountByEmail("private@example.com"), /Conflicting/);
});
test("paused new login still rejects legacy sessions and allows existing verified sessions and server logout", async () => {
  const f = await httpFixture(true);
  try {
    const sid = newOpaqueToken();
    f.repository.state.sessions.push({
      idHash: hashLoginToken(sid), userId: 42, createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
    });
    const cookie = `fixture_sid=${sid}; fixture_uid=42`;
    assert.equal((await f.request("/auth/email/request", { email: "new@example.com" })).status, 503);
    assert.equal(f.messages.length, 0);
    assert.equal((await fetch(`${f.base}/private`)).status, 401);
    assert.equal((await fetch(`${f.base}/private`, { headers: { cookie } })).status, 200);
    assert.equal((await f.request("/auth/logout", {}, cookie)).status, 204);
    assert.equal((await fetch(`${f.base}/private`, { headers: { cookie } })).status, 401);
  } finally { await f.close(); }
});
test("real JWT helpers: old signed cookie is insufficient in new mode; verified request identity is required", () => {
  const previousKey = process.env.SESSION_SECRET;
  const previousFlag = process.env.EMAIL_AUTH_ENABLED;
  try {
    process.env.SESSION_SECRET = "synthetic-key-for-offline-child-process-only";
    process.env.EMAIL_AUTH_ENABLED = "true";
    let cookie = "";
    const response = { cookie: (_name: string, value: string) => { cookie = value; } } as unknown as Response;
    setSessionCookie(response, 42);
    const req = { cookies: { requirements_session: cookie } } as unknown as Request;
    assert.equal(readSignedSession(req)?.userId, 42);
    assert.equal(readSignedSession(req)?.sid, undefined);
    assert.equal(getUserId(req), null);
    const sid = newOpaqueToken();
    setSessionCookie(response, 42, sid);
    const fresh = { cookies: { requirements_session: cookie } } as unknown as Request;
    assert.equal(readSignedSession(fresh)?.sid, sid);
    assert.equal(getUserId(fresh), null);
    attachVerifiedUser(fresh, 42);
    assert.equal(getUserId(fresh), 42);
  } finally {
    if (previousKey === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousKey;
    if (previousFlag === undefined) delete process.env.EMAIL_AUTH_ENABLED; else process.env.EMAIL_AUTH_ENABLED = previousFlag;
  }
});
