import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  EMAIL_AUTH_UI_ENABLED, apiUrl, emailAuthUrl, emailAuthFetch,
  getEmailCsrfToken, postEmailAuth, resetEmailCsrfToken, safeReturnPath,
} from "../../requirements-manager/src/lib/email-auth";
import {
  ApiError, customFetch, setAuthTokenGetter, setBaseUrl, setCsrfTokenGetter,
} from "../../../lib/api-client-react/src/custom-fetch";

declare const TEST_EMAIL_AUTH_BASE: string;
const base = TEST_EMAIL_AUTH_BASE.replace(/\/$/, "");
const label = `client ${base || "/"} ${EMAIL_AUTH_UI_ENABLED ? "enabled" : "disabled"}`;
const origin = "https://app.example.test";
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
type Call = { url: string; init?: RequestInit };
const requestUrl = (input: RequestInfo | URL) => input instanceof Request ? input.url : String(input);

beforeEach(() => {
  resetEmailCsrfToken();
  setCsrfTokenGetter(null);
  setAuthTokenGetter(null);
  setBaseUrl(null);
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { location: { origin, href: `${origin}${base}/login` } },
  });
  // Every test must replace this with an in-memory fake. No real HTTP fallback.
  globalThis.fetch = async () => { throw new Error("Network forbidden in offline client tests"); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  resetEmailCsrfToken();
  setCsrfTokenGetter(null);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test(`${label}: child has no database/mail credentials and API URLs retain base path`, () => {
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "RESEND_API_KEY", "SESSION_SECRET"]) {
    assert.equal(process.env[key], undefined);
  }
  assert.equal(apiUrl("/sessions/12/files"), `${base}/api/sessions/12/files`);
  assert.equal(emailAuthUrl("confirm"), `${base}/api/auth/email/confirm`);
});
test(`${label}: safe return paths become route-local without duplicating the artifact base`, () => {
  for (const route of ["/dashboard", "/chat/12", "/preview/33"]) {
    assert.equal(safeReturnPath(`${base}${route}`), route);
    assert.equal(safeReturnPath(`${base}${route}?view=detail`), `${route}?view=detail`);
  }
});
test(`${label}: malformed, external, encoded, traversal and unknown returns are rejected`, () => {
  for (const path of [null, 42, "", "https://evil.test", "//evil.test", "/\\evil.test",
    "/%2fevil.test", "/%252fevil.test", "/%0aevil", "/dashboard#token=secret",
    "/chat/../preview/1", "/%2e%2e/dashboard", "/other/dashboard", "/login", "/api/auth/logout",
    "/chat/NaN", "/preview/-1", "/preview/1?x=%", "/dashboard\n", "/dashboard?x=javascript:bad"]) {
    assert.equal(safeReturnPath(path), "/dashboard", String(path));
  }
});
test(`${label}: safe methods, external origins and other same-origin paths get no automatic CSRF`, async () => {
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => { calls.push({ url: requestUrl(input), init }); return json({}); };
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    await emailAuthFetch(apiUrl("sessions"), { method });
  }
  await emailAuthFetch("https://elsewhere.test/api/items", { method: "POST" });
  await emailAuthFetch(`${origin}/unrelated/submit`, { method: "POST" });
  if (base) await emailAuthFetch("/api/other-app", { method: "POST" });
  assert.equal(calls.some(c => c.url === emailAuthUrl("csrf")), false);
  for (const c of calls) assert.equal(new Headers(c.init?.headers).has("X-CSRF-Token"), false);
});

if (!EMAIL_AUTH_UI_ENABLED) {
  test(`${label}: disabled mode neither obtains a CSRF cookie nor rewrites outgoing requests`, async () => {
    const calls: Call[] = [];
    globalThis.fetch = async (input, init) => { calls.push({ url: requestUrl(input), init }); return json({}); };
    assert.equal(await getEmailCsrfToken(), "");
    const init = { method: "POST", headers: { "x-original": "kept" }, body: "test" };
    await emailAuthFetch(apiUrl("sessions"), init);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init, init);
  });
} else {
  test(`${label}: simultaneous mutations share one token and preserve Request plus init headers`, async () => {
    const calls: Call[] = [];
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      calls.push({ url, init });
      return url === emailAuthUrl("csrf") ? json({ csrf_token: "synthetic-token" }) : json({});
    };
    const request = new Request(`${origin}${apiUrl("sessions")}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-original": "kept" }, body: "{}",
    });
    await Promise.all([
      emailAuthFetch(request, { headers: { "x-extra": "present" } }),
      emailAuthFetch(apiUrl("transcribe"), { method: "POST", body: new FormData() }),
    ]);
    assert.equal(calls.filter(c => c.url === emailAuthUrl("csrf")).length, 1);
    const mutation = calls.find(c => c.url === request.url)!;
    const headers = new Headers(mutation.init?.headers);
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(headers.get("x-original"), "kept");
    assert.equal(headers.get("x-extra"), "present");
    assert.equal(headers.get("X-CSRF-Token"), "synthetic-token");
    assert.equal(mutation.init?.credentials, "same-origin");
    const upload = calls.find(c => c.url === apiUrl("transcribe"))!;
    assert.equal(new Headers(upload.init?.headers).has("Content-Type"), false);
  });
  test(`${label}: cached CSRF refreshes after twenty minutes without real timers`, async () => {
    let now = 100_000;
    Date.now = () => now;
    let calls = 0;
    globalThis.fetch = async () => json({ csrf_token: `synthetic-${++calls}` });
    assert.equal(await getEmailCsrfToken(), "synthetic-1");
    now += 19 * 60_000;
    assert.equal(await getEmailCsrfToken(), "synthetic-1");
    now += 2 * 60_000;
    assert.equal(await getEmailCsrfToken(), "synthetic-2");
    assert.equal(calls, 2);
  });
  test(`${label}: failed token fetch does not poison the cache`, async () => {
    let calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? json({}, 503) : json({ csrf_token: "recovered" });
    await assert.rejects(getEmailCsrfToken());
    assert.equal(await getEmailCsrfToken(), "recovered");
    assert.equal(calls, 2);
  });
  test(`${label}: direct 403 resets CSRF for the next user action but never retries a mutation`, async () => {
    let tokens = 0;
    let mutations = 0;
    globalThis.fetch = async input => {
      if (requestUrl(input) === emailAuthUrl("csrf")) return json({ csrf_token: `synthetic-${++tokens}` });
      mutations++;
      return json({ status: "forbidden" }, 403);
    };
    const first = await postEmailAuth("confirm", { token: "synthetic-link" });
    assert.equal(first.httpStatus, 403);
    assert.equal(tokens, 1);
    assert.equal(mutations, 1);
    await postEmailAuth("confirm", { token: "synthetic-link" });
    assert.equal(tokens, 2);
    assert.equal(mutations, 2);
  });
  test(`${label}: an old failing request cannot erase a replacement token cache`, async () => {
    let failOld!: (reason: Error) => void;
    let calls = 0;
    globalThis.fetch = () => ++calls === 1
      ? new Promise<Response>((_resolve, reject) => { failOld = reject; })
      : Promise.resolve(json({ csrf_token: "replacement" }));
    const old = getEmailCsrfToken();
    const rejected = assert.rejects(old);
    resetEmailCsrfToken();
    assert.equal(await getEmailCsrfToken(), "replacement");
    failOld(new Error("synthetic old failure"));
    await rejected;
    assert.equal(await getEmailCsrfToken(), "replacement");
    assert.equal(calls, 2);
  });
}

test(`${label}: generated client scopes its CSRF getter to this API and never invokes it for reads`, async () => {
  let tokens = 0;
  setCsrfTokenGetter(async () => { tokens++; return "synthetic-generated"; }, { pathPrefix: apiUrl("") });
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => { calls.push({ url: requestUrl(input), init }); return json({}); };
  await customFetch(apiUrl("sessions"));
  await customFetch("https://elsewhere.test/api/items", { method: "POST" });
  await customFetch("/unrelated/submit", { method: "POST" });
  if (base) await customFetch("/api/other-app", { method: "POST" });
  assert.equal(tokens, 0);
  await customFetch(apiUrl("sessions"), { method: "POST" });
  assert.equal(tokens, 1);
  assert.equal(new Headers(calls.at(-1)!.init?.headers).get("X-CSRF-Token"), "synthetic-generated");
});
test(`${label}: generated 403 is surfaced, invalidates the token, and is not automatically retried`, async () => {
  let invalidated = 0;
  let calls = 0;
  setCsrfTokenGetter(async () => "synthetic-generated", {
    pathPrefix: apiUrl(""), onRejected: () => { invalidated++; },
  });
  globalThis.fetch = async () => { calls++; return json({ error: "forbidden" }, 403); };
  await assert.rejects(customFetch(apiUrl("sessions"), { method: "POST" }), ApiError);
  assert.equal(calls, 1);
  assert.equal(invalidated, 1);
  await assert.rejects(customFetch("https://elsewhere.test/api/items", { method: "POST" }), ApiError);
  assert.equal(invalidated, 1);
});
