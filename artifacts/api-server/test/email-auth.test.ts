import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOGIN_TTL_MS, accountSwitchDecision, buildConfirmationLink, createLoginChallenge,
  emailLoginAccess, evaluateSendLimits, hashLoginToken, inspectLoginChallenge,
  newOpaqueToken, normalizeLoginEmail, safeReturnPath, trustedPublicUrl, validConfirmationRequest,
} from "../src/modules/email-auth/security";
import { LOGIN_REQUEST_MESSAGE, renderLoginEmail } from "../src/modules/email-auth/email-template";

const now = new Date("2026-11-05T12:00:00Z");
test("offline process has no database or email credentials", () => {
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.TEST_DATABASE_URL, undefined);
  assert.equal(process.env.RESEND_API_KEY, undefined);
});
test("email normalization preserves dots and plus-addressing, but does not verify ownership", () => {
  assert.equal(normalizeLoginEmail(" A.B+Test@Example.com "), "a.b+test@example.com");
});
for (const value of ["", "bad", "x@@example.com", "x@example", "x@example.com\nBcc:x@y.com"]) {
  test(`reject malformed email ${JSON.stringify(value)}`, () => {
    assert.throws(() => normalizeLoginEmail(value));
  });
}
test("challenge has a 256-bit token, fixed purpose and exact fifteen-minute TTL", () => {
  const { token, challenge } = createLoginChallenge("test@example.com", now);
  assert.match(token, /^[\w-]{43}$/);
  assert.match(challenge.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(challenge.tokenHash, hashLoginToken(token));
  assert.ok(!JSON.stringify(challenge).includes(token));
  assert.equal(challenge.expiresAt.getTime() - now.getTime(), LOGIN_TTL_MS);
  assert.equal(challenge.purpose, "email_login");
  assert.equal(new Set(Array.from({ length: 100 }, newOpaqueToken)).size, 100);
});
test("inspection is read-only and binds token, purpose, email, expiry and used state", () => {
  const { token, challenge } = createLoginChallenge("test@example.com", now);
  const before = JSON.stringify(challenge);
  assert.equal(inspectLoginChallenge(challenge, token, "test@example.com", now), "valid");
  assert.equal(JSON.stringify(challenge), before);
  assert.equal(inspectLoginChallenge(challenge, token, "other@example.com", now), "invalid");
  assert.equal(inspectLoginChallenge(challenge, newOpaqueToken(), challenge.email, now), "invalid");
  assert.equal(inspectLoginChallenge(challenge, "", challenge.email, now), "invalid");
  assert.equal(inspectLoginChallenge(challenge, token, challenge.email, challenge.expiresAt), "expired");
  assert.equal(inspectLoginChallenge({ ...challenge, usedAt: now }, token, challenge.email, now), "used");
  assert.equal(inspectLoginChallenge({ ...challenge, purpose: "reset" } as never, token, challenge.email, now), "invalid");
});
test("links use configured origin and base path; token stays out of HTTP query/path", () => {
  const token = newOpaqueToken();
  const url = new URL(buildConfirmationLink("https://app.example.com/product/", token));
  assert.equal(url.origin, "https://app.example.com");
  assert.equal(url.pathname, "/product/auth/confirm");
  assert.equal(url.search, "");
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("token"), token);
});
for (const url of [
  "http://public.example.com", "javascript:alert(1)", "https://user:password@example.com",
  "https://example.com/?host=bad", "https://example.com/#token=bad",
]) {
  test(`reject unsafe configured URL ${url}`, () => assert.throws(() => trustedPublicUrl(url)));
}
test("POST requires exact Origin and matching CSRF proof; GET never confirms", () => {
  const csrf = newOpaqueToken();
  const request = { method: "POST", origin: "https://app.example.com",
    publicUrl: "https://app.example.com/", csrfCookie: csrf, csrfHeader: csrf };
  assert.equal(validConfirmationRequest(request), true);
  assert.equal(validConfirmationRequest({ ...request, method: "GET" }), false);
  assert.equal(validConfirmationRequest({ ...request, origin: undefined }), false);
  assert.equal(validConfirmationRequest({ ...request, origin: "https://app.example.com.evil.test" }), false);
  assert.equal(validConfirmationRequest({ ...request, csrfHeader: newOpaqueToken() }), false);
  assert.equal(validConfirmationRequest({ ...request, csrfCookie: undefined }), false);
});
for (const path of [
  "//evil.test", "/\\evil.test", "/%2fevil.test", "/%5cevil.test", "/%252fevil.test",
  "/%0aevil", "https://evil.test", "/outside", "/app/../../outside", "/app/%",
]) {
  test(`unsafe return path falls back: ${path}`, () => {
    assert.equal(safeReturnPath(path, "https://app.example.com/app/"), "/app/dashboard");
  });
}
test("safe internal return path remains within artifact base", () => {
  assert.equal(safeReturnPath("/app/preview/1?tab=tz", "https://app.example.com/app/"), "/app/preview/1?tab=tz");
});
test("mailbox proof is sufficient for old accounts; a password never replaces mailbox proof", () => {
  const account = { id: 1, email: "test@example.com", emailVerifiedAt: null };
  const valid = { mailboxConfirmed: true, account, passwordProof: { userId: 1, email: account.email } };
  assert.equal(emailLoginAccess(valid), "existing");
  assert.equal(emailLoginAccess({ ...valid, passwordProof: null }), "existing");
  assert.equal(emailLoginAccess({ ...valid, mailboxConfirmed: false }), "mailbox_required");
  assert.equal(emailLoginAccess({ ...valid, passwordProof: { userId: 2, email: account.email } }), "existing");
  assert.equal(emailLoginAccess({ ...valid, passwordProof: { userId: 1, email: "other@example.com" } }), "existing");
  assert.equal(emailLoginAccess({ ...valid, account: { ...account, emailVerifiedAt: now }, passwordProof: null }), "existing");
  assert.equal(emailLoginAccess({ ...valid, account: null, passwordProof: null }), "create_new");
  assert.equal(emailLoginAccess({ ...valid, account: null, mailboxConfirmed: false }), "mailbox_required");
});
test("switching accounts requires consent; same-account login does not", () => {
  assert.equal(accountSwitchDecision(1, 2, false), "consent_required");
  assert.equal(accountSwitchDecision(1, 2, true), "continue");
  assert.equal(accountSwitchDecision(1, 1, false), "continue");
  assert.equal(accountSwitchDecision(null, 1, false), "continue");
});
test("pure send policy enforces minute, hour and explicitly configured IP limits", () => {
  const time = now.getTime();
  const input = { now: time, emailSentAt: [], ipSentAt: [], ipMaxPerHour: 20 };
  assert.deepEqual(evaluateSendLimits(input), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(evaluateSendLimits({ ...input, emailSentAt: [time - 1000] }), { allowed: false, retryAfterSeconds: 59 });
  assert.equal(evaluateSendLimits({ ...input, emailSentAt: [time - 60_000] }).allowed, true);
  assert.equal(evaluateSendLimits({ ...input, emailSentAt: [1, 2, 3, 4, 5].map(n => time - n * 120_000) }).allowed, false);
  assert.equal(evaluateSendLimits({ ...input, ipSentAt: Array(20).fill(time - 1000) }).allowed, false);
  assert.equal(evaluateSendLimits({ ...input, emailSentAt: Array(5).fill(time - 3_600_000) }).allowed, true);
  assert.throws(() => evaluateSendLimits({ ...input, ipMaxPerHour: 0 }));
});
test("email template renders without sending mail or issuing a password", () => {
  const result = renderLoginEmail("https://app.example.com/", newOpaqueToken());
  assert.match(result.text, /15 минут/);
  assert.match(result.text, /не запрашивали вход/);
  assert.match(result.html, /Войти в Мои ТЗ/);
  assert.doesNotMatch(result.text, /Подтвердить и войти/);
  assert.ok(!result.text.includes("пароль"));
  assert.match(LOGIN_REQUEST_MESSAGE, /Если адрес указан верно/);
});
