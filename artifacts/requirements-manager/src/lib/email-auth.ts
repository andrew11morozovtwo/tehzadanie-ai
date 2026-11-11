export const EMAIL_AUTH_UI_ENABLED = import.meta.env.VITE_EMAIL_AUTH_ENABLED === "true";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export const apiUrl = (path: string) => `${BASE}/api/${path.replace(/^\/+/, "")}`;
export const emailAuthUrl = (path: string) => apiUrl(`auth/email/${path}`);

// Server cookie lives 30 min; refresh locally well before that.
const CSRF_TTL_MS = 20 * 60 * 1000;
let csrfPromise: Promise<string> | null = null;
let csrfFetchedAt = 0;

export function resetEmailCsrfToken() {
  csrfPromise = null;
  csrfFetchedAt = 0;
}

export function getEmailCsrfToken(): Promise<string> {
  if (!EMAIL_AUTH_UI_ENABLED) return Promise.resolve("");
  if (csrfPromise && Date.now() - csrfFetchedAt > CSRF_TTL_MS) resetEmailCsrfToken();
  if (!csrfPromise) {
    csrfFetchedAt = Date.now();
    const p: Promise<string> = fetch(emailAuthUrl("csrf"), { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error("csrf");
        const data = (await r.json()) as { csrf_token?: string };
        if (!data.csrf_token) throw new Error("csrf");
        return data.csrf_token;
      })
      .catch((e) => {
        if (csrfPromise === p) resetEmailCsrfToken();
        throw e;
      });
    csrfPromise = p;
  }
  return csrfPromise;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

function isSameOriginApi(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin) return false;
    return url.pathname.startsWith(`${BASE}/api/`);
  } catch {
    return false;
  }
}

export async function emailAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!EMAIL_AUTH_UI_ENABLED) return fetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (SAFE.has(method) || !isSameOriginApi(input)) return fetch(input, init);
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.set("X-CSRF-Token", await getEmailCsrfToken());
  const res = await fetch(input, { ...init, headers, credentials: "same-origin" });
  // No automatic retry: the next user action fetches a fresh token.
  if (res.status === 403) resetEmailCsrfToken();
  return res;
}

const ALLOWED_ROUTE = /^\/(dashboard|chat\/\d+|preview\/\d+)\/?$/;

/**
 * Converts a server-provided return path (which may include BASE_URL) into a
 * wouter route-local path. Anything suspicious falls back.
 */
export function safeReturnPath(value: unknown, fallback = "/dashboard"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return fallback;
  // Reject raw controls, backslashes, whitespace, fragments, schemes.
  if (/[\u0000-\u001f\u007f\\\s#]/.test(value) || value.includes(":")) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  // Reject any percent-encoding of slash, backslash, dot, percent or controls.
  if (/%(2f|5c|2e|25|[01][0-9a-f]|7f)/i.test(value)) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (decoded !== value && /[\u0000-\u001f\u007f\\\s#:]/.test(decoded)) return fallback;
  const [pathPart, query = ""] = value.split("?", 2);
  if (pathPart.split("/").some((seg) => seg === "." || seg === "..")) return fallback;
  let local = pathPart;
  if (BASE) {
    if (local === BASE || local === `${BASE}/`) return fallback;
    if (local.startsWith(`${BASE}/`)) local = local.slice(BASE.length);
  }
  if (!ALLOWED_ROUTE.test(local)) return fallback;
  return query ? `${local}?${query}` : local;
}

export async function postEmailAuth<T>(path: string, body: unknown): Promise<{ ok: boolean; httpStatus: number; data: T }> {
  const r = await emailAuthFetch(emailAuthUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as T;
  return { ok: r.ok, httpStatus: r.status, data };
}
