import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "@workspace/db";
import { PostgresEmailAuthRepository } from "../src/modules/email-auth/postgres-repository";
import { createEmailAuthService } from "../src/modules/email-auth/service";
import type { EmailAuthRepository, EmailAuthTransaction } from "../src/modules/email-auth/contracts";
import { hashLoginToken } from "../src/modules/email-auth/security";

const run = randomBytes(8).toString("hex");
const publicUrl = process.env.AUTH_PUBLIC_URL!;
const origin = new URL(publicUrl).origin;
const repository = new PostgresEmailAuthRepository(pool);
const links = new Map<string, string>();
const email = (tag: string) => `auth-check-${run}-${tag}@example.invalid`;
const ipKey = (tag: string) => createHash("sha256").update(`auth-check-${run}-${tag}`).digest("hex");
const serviceFor = (repo: EmailAuthRepository = repository) => createEmailAuthService({
  repository: repo, publicUrl, ipMaxPerHour: 100, verifyPassword: bcrypt.compare,
  mailer: { send: async message => {
    const match = message.text.match(/https?:\/\/[^\s]+/);
    if (!match) throw new Error("Synthetic email missing link");
    links.set(message.to, match[0]);
  } },
});
const service = serviceFor();
const token = (address: string) => new URLSearchParams(new URL(links.get(address)!).hash.slice(1)).get("token")!;
const input = (value: string, extra: Record<string, unknown> = {}) => ({
  token: value, name: "Проверка авторизации", currentUserId: null, switchConsent: false,
  request: { method: "POST", origin, csrfCookie: "a".repeat(43), csrfHeader: "a".repeat(43) }, ...extra,
});
async function issue(tag: string) {
  const address = email(tag);
  assert.equal((await service.requestLink({ email: address, ipKey: ipKey(tag) })).status, "accepted");
  return { address, token: token(address) };
}
before(async () => {
  assert.equal(process.env.AUTH_DEV_TESTS_APPROVED, "true");
  const { rows } = await pool.query("SELECT current_database() AS db, current_user AS role");
  assert.equal(rows[0].db === "heliumdb" && rows[0].role === "postgres", true, "Tests require the verified local dev database");
  assert.equal(process.env.RESEND_API_KEY, undefined, "Do not give the test process real mail credentials");
  assert.equal(new URL(publicUrl).hostname.endsWith(".replit.dev"), true);
});
after(async () => { await pool.end(); });

test("PostgreSQL: request creates no account; explicit confirmation creates one verified user; link is single-use", async () => {
  const f = await issue("single");
  assert.equal(await repository.readAccountByEmail(f.address), null);
  assert.equal((await service.previewLink(f.token)).status, "valid");
  assert.equal(await repository.readAccountByEmail(f.address), null);
  const result = await service.confirm(input(f.token));
  assert.equal(result.status, "confirmed");
  if (result.status !== "confirmed") return;
  assert.equal(await service.sessionUserId(result.sessionId), result.user.id);
  assert.equal((await service.confirm(input(f.token))).status, "used");
  const account = await repository.readAccountByEmail(f.address);
  assert.equal(account?.passwordHash, null);
  assert.equal(account?.emailVerifiedAt instanceof Date, true);
});
test("PostgreSQL: eight concurrent confirmations produce exactly one user and one server session", async () => {
  const f = await issue("concurrent");
  const results = await Promise.all(Array.from({ length: 8 }, () => service.confirm(input(f.token))));
  assert.equal(results.filter(r => r.status === "confirmed").length, 1);
  assert.equal(results.filter(r => r.status === "used").length, 7);
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE u.email=$1", [f.address],
  );
  assert.equal(rows[0].n, 1);
});
test("PostgreSQL: session failure rolls back account, verification, token consumption and inserted session", async () => {
  const f = await issue("rollback");
  const failing: EmailAuthRepository = {
    readAccountByEmail: value => repository.readAccountByEmail(value),
    readChallenge: value => repository.readChallenge(value), readSession: value => repository.readSession(value),
    transaction: work => repository.transaction(tx => work(new Proxy(tx, {
      get(target, key) {
        if (key === "insertSession") return async (value: Parameters<EmailAuthTransaction["insertSession"]>[0]) => {
          await target.insertSession(value);
          throw new Error("Synthetic failure after session INSERT");
        };
        const member = target[key as keyof EmailAuthTransaction];
        return typeof member === "function" ? member.bind(target) : member;
      },
    }))),
  };
  assert.equal((await serviceFor(failing).confirm(input(f.token))).status, "unavailable");
  assert.equal(await repository.readAccountByEmail(f.address), null);
  assert.equal((await repository.readChallenge(hashLoginToken(f.token)))?.usedAt, null);
  assert.equal((await service.confirm(input(f.token))).status, "confirmed");
});
test("PostgreSQL: first verification of a synthetic legacy account uses only its link and preserves its hash", async () => {
  const address = email("legacy");
  const hash = await bcrypt.hash(`synthetic-password-${run}`, 8);
  const { rows } = await pool.query(
    "INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id",
    ["Проверка старого аккаунта", address, hash],
  );
  assert.equal((await service.requestLink({ email: address, ipKey: ipKey("legacy") })).status, "accepted");
  assert.equal((await repository.readAccountByEmail(address))?.emailVerifiedAt, null);
  const result = await service.confirm(input(token(address)));
  assert.equal(result.status, "confirmed");
  if (result.status !== "confirmed") return;
  assert.equal(result.user.id, rows[0].id);
  assert.equal((await repository.readAccountByEmail(address))?.passwordHash === hash, true);
});
test("PostgreSQL: parallel send requests cannot bypass email cooldown", async () => {
  const address = email("send-race");
  const results = await Promise.all(Array.from({ length: 6 }, () => service.requestLink({
    email: address, ipKey: ipKey("send-race"),
  })));
  assert.equal(results.filter(r => r.status === "accepted").length, 1);
  assert.equal(results.filter(r => r.status === "limited").length, 5);
});

async function browserSession(tag: string) {
  const f = await issue(tag);
  const csrfResponse = await fetch("http://127.0.0.1:80/api/auth/email/csrf");
  assert.equal(csrfResponse.status, 200);
  const csrf = (await csrfResponse.json()).csrf_token as string;
  let cookie = csrfResponse.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const request = (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:80/api${path}`, {
    method, headers: { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const inspect = await request("/auth/email/inspect", "POST", { token: f.token });
  assert.equal((await inspect.json()).status, "valid");
  const response = await request("/auth/email/confirm", "POST", {
    token: f.token, name: "Проверка HTTP", switch_consent: false,
  });
  assert.equal(response.status, 200);
  cookie += "; " + response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const result = await response.json();
  assert.equal(result.status, "confirmed");
  return { request, id: result.user.id as number, cookie, token: f.token };
}
test("Live preview HTTP + PostgreSQL: owner isolation for projects/messages/documents/files and server-side logout", async () => {
  const a = await browserSession("http-a");
  const b = await browserSession("http-b");
  assert.equal((await a.request("/auth/me")).status, 200);
  const created = await a.request("/sessions", "POST", { title: `Проверка изоляции ${run}` });
  assert.equal(created.status, 201);
  const project = await created.json();
  const id = Number(project.id);
  assert.equal(Number.isSafeInteger(id), true);
  await pool.query("INSERT INTO project_documents (session_id,markdown) VALUES ($1,$2)", [id, "Тестовый документ проверки авторизации"]);
  await pool.query(
    "INSERT INTO reference_files (session_id,user_id,original_name,mime_type,size,data) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, a.id, "synthetic-auth-test.txt", "text/plain", 4, "dGVzdA=="],
  );
  const ownList = await (await a.request("/sessions")).json();
  assert.equal(ownList.every((item: { id: number }) => item.id === id), true);
  assert.equal((await a.request(`/sessions/${id}`)).status, 200);
  assert.equal((await a.request(`/sessions/${id}/tz`)).status, 200);
  assert.equal((await a.request(`/sessions/${id}/files`)).status, 200);
  for (const path of [`/sessions/${id}`, `/sessions/${id}/tz`, `/sessions/${id}/files`]) {
    assert.equal((await b.request(path)).status, 404);
  }
  const replay = await a.request("/auth/email/confirm", "POST", { token: a.token, switch_consent: false });
  assert.equal(replay.status, 410);
  const legacy = jwt.sign({ userId: a.id }, process.env.SESSION_SECRET!, { expiresIn: "1h" });
  assert.equal((await fetch("http://127.0.0.1:80/api/auth/me", {
    headers: { cookie: `requirements_session=${legacy}` },
  })).status, 401);
  assert.equal((await a.request("/auth/logout", "POST", {})).status, 204);
  assert.equal((await a.request("/auth/me")).status, 401, "A copied cookie must fail after server-side revocation");
});
test("Browser fixture: mock a single mail for a new, exclusively synthetic account; never expose the link in logs", async () => {
  const f = await issue("browser");
  assert.equal(await repository.readAccountByEmail(f.address), null);
  const path = process.env.AUTH_BROWSER_FIXTURE_FILE;
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      confirmationUrl: links.get(f.address), name: `Проверка браузера ${run}`,
    }), { mode: 0o600 });
  }
});
