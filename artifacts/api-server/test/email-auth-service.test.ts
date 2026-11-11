import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmailAuthService } from "../src/modules/email-auth/service";
import { hashLoginToken, LOGIN_TTL_MS, newOpaqueToken } from "../src/modules/email-auth/security";
import { MemoryEmailAuthRepository } from "./email-auth.fixture";

const start = new Date("2026-11-05T12:00:00Z");
const ipKey = "a".repeat(64);
function fixture() {
  const repository = new MemoryEmailAuthRepository();
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  const controls = { now: new Date(start), mailFails: false, passwordChecks: 0, slowPassword: false };
  const service = createEmailAuthService({
    repository, publicUrl: "https://app.example.com/", ipMaxPerHour: 20,
    clock: () => new Date(controls.now),
    mailer: { send: async message => {
      if (controls.mailFails) throw new Error("Sensitive provider error");
      sent.push(message);
    } },
    verifyPassword: async (plain, hash) => {
      controls.passwordChecks++;
      if (controls.slowPassword) controls.now = new Date(start.getTime() + LOGIN_TTL_MS);
      return plain === "test-only-password" && hash === "test-only-hash";
    },
  });
  const csrf = newOpaqueToken();
  const request = { method: "POST", origin: "https://app.example.com", csrfCookie: csrf, csrfHeader: csrf };
  const params = (token: string) => ({
    token, name: "Тестовый пользователь", currentUserId: null, switchConsent: false, request,
  });
  async function link(email = "new@example.com") {
    assert.equal((await service.requestLink({ email, ipKey })).status, "accepted");
    const rawUrl = sent.at(-1)!.text.split("\n\n")[2];
    return new URLSearchParams(new URL(rawUrl).hash.slice(1)).get("token")!;
  }
  function account(verified = false) {
    repository.state.accounts.push({
      id: 42, email: "old@example.com", name: "Прежнее имя",
      passwordHash: "test-only-hash", emailVerifiedAt: verified ? start : null,
    });
  }
  return { repository, service, sent, controls, params, link, account };
}

test("service request creates only a pending login challenge, not a user or session", async () => {
  const f = fixture();
  const token = await f.link();
  assert.equal(f.repository.state.accounts.length, 0);
  assert.equal(f.repository.state.sessions.length, 0);
  assert.ok(!JSON.stringify(f.repository.state).includes(token));
  assert.equal(f.repository.state.challenges[0].delivery, "ready");
  assert.equal(f.repository.state.challenges[0].usedAt, null);
});
test("new, legacy and verified accounts receive identical neutral request responses", async () => {
  const responses = [];
  for (const state of ["new", "legacy", "verified"]) {
    const f = fixture();
    if (state !== "new") f.account(state === "verified");
    responses.push(await f.service.requestLink({ email: "old@example.com", ipKey }));
    assert.equal(f.controls.passwordChecks, 0);
  }
  assert.deepEqual(responses[0], responses[1]);
  assert.deepEqual(responses[1], responses[2]);
});
test("previewing the email link is repeatable and performs no state changes", async () => {
  const f = fixture();
  const token = await f.link();
  const before = structuredClone(f.repository.state);
  assert.equal((await f.service.previewLink(token)).status, "valid");
  assert.equal((await f.service.previewLink(token)).status, "valid");
  assert.deepEqual(f.repository.state, before);
});
test("new account is created only on protected confirmation, without a password", async () => {
  const f = fixture();
  const token = await f.link();
  const result = await f.service.confirm(f.params(token));
  assert.equal(result.status, "confirmed");
  if (result.status !== "confirmed") return;
  assert.equal(f.repository.state.accounts.length, 1);
  assert.deepEqual(f.repository.state.accounts[0].emailVerifiedAt, start);
  assert.equal(f.repository.state.accounts[0].passwordHash, null);
  assert.equal("password" in result.user, false);
  assert.equal("passwordHash" in result.user, false);
  assert.equal(f.repository.state.sessions[0].idHash, hashLoginToken(result.sessionId));
  assert.ok(!JSON.stringify(f.repository.state).includes(result.sessionId));
  assert.equal(await f.service.sessionUserId(result.sessionId), result.user.id);
  assert.equal((await f.service.confirm(f.params(token))).status, "used");
  assert.equal(f.repository.state.sessions.length, 1);
});
test("new account needs no name; blank, missing and excessive names use a neutral display name", async () => {
  for (const name of [undefined, "", "  ", "x".repeat(121)]) {
    const f = fixture();
    const result = await f.service.confirm({ ...f.params(await f.link()), name });
    assert.equal(result.status, "confirmed");
    assert.equal(f.repository.state.accounts[0].name, "Пользователь");
    assert.equal(f.repository.state.accounts[0].passwordHash, null);
  }
});
test("verified account retains its ID, name and old hash; password is not required", async () => {
  const f = fixture();
  f.account(true);
  const result = await f.service.confirm(f.params(await f.link("old@example.com")));
  assert.equal(result.status, "confirmed");
  if (result.status !== "confirmed") return;
  assert.equal(result.user.id, 42);
  assert.equal(result.user.name, "Прежнее имя");
  assert.equal(f.repository.state.accounts.length, 1);
  assert.equal(f.repository.state.accounts[0].passwordHash, "test-only-hash");
  assert.equal(f.controls.passwordChecks, 0);
});
test("legacy mailbox proof opens the same account without any password and preserves its hash", async () => {
  const f = fixture();
  f.account();
  const token = await f.link("old@example.com");
  const result = await f.service.confirm(f.params(token));
  assert.equal(result.status, "confirmed");
  if (result.status === "confirmed") assert.equal(result.user.id, 42);
  assert.equal(f.repository.state.accounts[0].passwordHash, "test-only-hash");
  assert.deepEqual(f.repository.state.accounts[0].emailVerifiedAt, start);
  assert.equal(f.controls.passwordChecks, 0);
});
test("obsolete password input cannot change mailbox-only login or alter the stored hash", async () => {
  const f = fixture();
  f.account();
  const token = await f.link("old@example.com");
  assert.equal((await f.service.confirm({ ...f.params(token), password: "wrong" })).status, "confirmed");
  assert.equal(f.controls.passwordChecks, 0);
  assert.equal(f.repository.state.accounts[0].passwordHash, "test-only-hash");
  assert.equal((await f.service.confirm(f.params(token))).status, "used");
});
test("expired legacy link cannot verify an old account even with a supplied password", async () => {
  const f = fixture();
  f.account();
  const token = await f.link("old@example.com");
  f.controls.now = new Date(start.getTime() + LOGIN_TTL_MS);
  assert.equal((await f.service.confirm({ ...f.params(token), password: "test-only-password" })).status, "expired");
  assert.equal(f.repository.state.accounts[0].emailVerifiedAt, null);
  assert.equal(f.repository.state.sessions.length, 0);
});
test("switch consent is required before either existing login or new-account creation", async () => {
  for (const existing of [false, true]) {
    const f = fixture();
    if (existing) f.account(true);
    const token = await f.link(existing ? "old@example.com" : "new@example.com");
    const before = structuredClone(f.repository.state);
    const input = { ...f.params(token), currentUserId: 999 };
    assert.equal((await f.service.confirm(input)).status, "consent_required");
    assert.deepEqual(f.repository.state, before);
    assert.equal((await f.service.confirm({ ...input, switchConsent: true })).status, "confirmed");
  }
});
test("same-account login needs no switch consent", async () => {
  const f = fixture();
  f.account(true);
  const token = await f.link("old@example.com");
  assert.equal((await f.service.confirm({ ...f.params(token), currentUserId: 42 })).status, "confirmed");
});
test("GET, bad Origin and missing CSRF are refused before repository access", async () => {
  const f = fixture();
  const token = await f.link();
  const params = f.params(token);
  const before = f.repository.calls;
  for (const request of [
    { ...params.request, method: "GET" },
    { ...params.request, origin: "https://evil.example.com" },
    { ...params.request, csrfHeader: undefined },
  ]) {
    assert.equal((await f.service.confirm({ ...params, request })).status, "forbidden");
  }
  assert.equal(f.repository.calls, before);
});
test("expired, missing and malformed tokens never create a user", async () => {
  const f = fixture();
  const token = await f.link();
  f.controls.now = new Date(start.getTime() + LOGIN_TTL_MS);
  assert.equal((await f.service.confirm(f.params(token))).status, "expired");
  assert.equal((await f.service.confirm(f.params(newOpaqueToken()))).status, "invalid");
  assert.equal((await f.service.confirm(f.params(""))).status, "invalid");
  assert.equal(f.repository.state.accounts.length, 0);
});
test("mail failure does not leak provider errors or yield a usable challenge", async () => {
  const f = fixture();
  f.controls.mailFails = true;
  assert.deepEqual(await f.service.requestLink({ email: "new@example.com", ipKey }), { status: "unavailable" });
  assert.equal(f.repository.state.challenges[0].delivery, "failed");
  assert.equal(f.repository.state.accounts.length, 0);
});
test("a pending, not-yet-delivered challenge cannot be confirmed", async () => {
  const f = fixture();
  const token = await f.link();
  f.repository.state.challenges[0].delivery = "pending";
  assert.equal((await f.service.previewLink(token)).status, "invalid");
  assert.equal((await f.service.confirm(f.params(token))).status, "invalid");
});
test("session insert failure rolls back new account creation and token consumption in the mock", async () => {
  const f = fixture();
  const token = await f.link();
  const before = structuredClone(f.repository.state);
  f.repository.failSessionInsert = true;
  assert.equal((await f.service.confirm(f.params(token))).status, "unavailable");
  assert.deepEqual(f.repository.state, before);
});
test("session insert failure rolls back legacy verification in the mock", async () => {
  const f = fixture();
  f.account();
  const token = await f.link("old@example.com");
  const before = structuredClone(f.repository.state);
  f.repository.failSessionInsert = true;
  assert.equal((await f.service.confirm({ ...f.params(token), password: "test-only-password" })).status, "unavailable");
  assert.deepEqual(f.repository.state, before);
});
test("failed compare-and-consume rolls back account creation in the mock", async () => {
  const f = fixture();
  const token = await f.link();
  const before = structuredClone(f.repository.state);
  f.repository.failConsume = true;
  assert.equal((await f.service.confirm(f.params(token))).status, "used");
  assert.deepEqual(f.repository.state, before);
});
test("two mock-serialized confirmations yield just one user and one session, not a PostgreSQL guarantee", async () => {
  const f = fixture();
  const token = await f.link();
  const results = await Promise.all([f.service.confirm(f.params(token)), f.service.confirm(f.params(token))]);
  assert.deepEqual(results.map(r => r.status).sort(), ["confirmed", "used"]);
  assert.equal(f.repository.state.accounts.length, 1);
  assert.equal(f.repository.state.sessions.length, 1);
});
test("request limits prevent a second mail within a minute, including mock-serialized requests", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.service.requestLink({ email: "new@example.com", ipKey }),
    f.service.requestLink({ email: "new@example.com", ipKey }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), ["accepted", "limited"]);
  assert.equal(f.sent.length, 1);
});
test("revocation blocks a copied session ID and no legacy JWT is accepted by the new service", async () => {
  const f = fixture();
  const result = await f.service.confirm(f.params(await f.link()));
  assert.equal(result.status, "confirmed");
  if (result.status !== "confirmed") return;
  assert.equal(await f.service.sessionUserId(undefined), null);
  assert.equal(await f.service.sessionUserId("not-a-session-id"), null);
  assert.equal(await f.service.sessionUserId(result.sessionId), result.user.id);
  assert.equal(await f.service.revokeSession(result.sessionId), true);
  assert.equal(await f.service.sessionUserId(result.sessionId), null);
});
test("new service sessions expire after thirty days", async () => {
  const f = fixture();
  const result = await f.service.confirm(f.params(await f.link()));
  if (result.status !== "confirmed") return assert.fail("Expected login");
  f.controls.now = new Date(start.getTime() + 30 * 24 * 60 * 60_000);
  assert.equal(await f.service.sessionUserId(result.sessionId), null);
});
test("confirmed login rotates and revokes the prior current session atomically in the mock", async () => {
  const f = fixture();
  const first = await f.service.confirm(f.params(await f.link()));
  if (first.status !== "confirmed") return assert.fail("Expected first login");
  f.controls.now = new Date(start.getTime() + 60_000);
  const second = await f.service.confirm({
    ...f.params(await f.link()), currentUserId: first.user.id, currentSessionId: first.sessionId,
  });
  if (second.status !== "confirmed") return assert.fail("Expected second login");
  assert.equal(await f.service.sessionUserId(first.sessionId), null);
  assert.equal(await f.service.sessionUserId(second.sessionId), first.user.id);
  assert.equal(f.repository.state.accounts.length, 1);
});
