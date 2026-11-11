import type { EmailAuthRepository, LoginMailer } from "./contracts";
import { LOGIN_REQUEST_MESSAGE, renderLoginEmail } from "./email-template";
import {
  createLoginChallenge, evaluateSendLimits, hashLoginToken,
  inspectLoginChallenge, newOpaqueToken, normalizeLoginEmail, safeReturnPath,
  trustedPublicUrl, validConfirmationRequest,
} from "./security";

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
class ConsumeConflict extends Error {}

export type ConfirmationResult =
  | { status: "confirmed"; user: { id: number; name: string; email: string }; sessionId: string; returnTo: string; isNew: boolean }
  | { status: "legacy_password_required"; message: string }
  | { status: "invalid" | "expired" | "used" | "forbidden" | "consent_required" | "name_required" | "legacy_attempts_exhausted" | "unavailable" };

/**
 * Inactive orchestration: no default repository, mail provider, environment reads
 * or route registration. Integrate ONLY after testing a real isolated DB adapter.
 */
export function createEmailAuthService(options: {
  repository: EmailAuthRepository;
  mailer: LoginMailer;
  verifyPassword: (plain: string, hash: string) => Promise<boolean>;
  publicUrl: string;
  ipMaxPerHour: number;
  legacyMaxAttempts?: number;
  clock?: () => Date;
  /** Server-only canary gate; fixed permit hash persists in the challenge ledger. */
  previewSendPolicy?: { recipient: string; approved: boolean; permitKey: string };
}) {
  const { repository, mailer, publicUrl, ipMaxPerHour } = options;
  trustedPublicUrl(publicUrl);
  if (!Number.isInteger(ipMaxPerHour) || ipMaxPerHour < 1) throw new Error("Не задан лимит IP");
  const clock = options.clock ?? (() => new Date());
  const previewPolicy = options.previewSendPolicy && Object.freeze({ ...options.previewSendPolicy });
  if (previewPolicy && (normalizeLoginEmail(previewPolicy.recipient) !== previewPolicy.recipient ||
    !/^[a-f0-9]{64}$/.test(previewPolicy.permitKey))) throw new Error("Invalid preview delivery policy");
  const tokenHash = (token: string): string | null => {
    try { return hashLoginToken(token); } catch { return null; }
  };
  const inspect = async (token: string) => {
    const hash = tokenHash(token);
    if (!hash) return { status: "invalid" as const };
    const challenge = await repository.readChallenge(hash);
    if (!challenge || challenge.delivery !== "ready") return { status: "invalid" as const };
    const status = inspectLoginChallenge(challenge, token, challenge.email, clock());
    if (status !== "valid") return { status };
    const [local, domain] = challenge.email.split("@");
    return {
      status, email: `${local.slice(0, 1)}***@${domain}`,
      requires_name: false,
      requires_legacy_password: false,
    };
  };

  return {
    async requestLink(input: { email: string; ipKey: string }): Promise<
      | { status: "accepted"; message: string }
      | { status: "invalid_email" | "unavailable" }
      | { status: "limited"; retryAfterSeconds: number }
    > {
      let email: string;
      try { email = normalizeLoginEmail(input.email); } catch { return { status: "invalid_email" }; }
      if (previewPolicy && (!previewPolicy.approved || email !== previewPolicy.recipient)) {
        return { status: "unavailable" };
      }
      // Server-derived keyed hash of the trusted client IP, NEVER a browser field.
      if (!/^[a-f0-9]{64}$/.test(input.ipKey)) return { status: "unavailable" };
      const now = clock();
      const scopeKey = previewPolicy?.permitKey ?? input.ipKey;
      const { token, challenge } = createLoginChallenge(email, now);
      try {
        const limit = await repository.transaction(async tx => {
          await tx.lockRequestScope(email, scopeKey);
          if (previewPolicy) {
            const lifetime = await tx.requestHistory(email, scopeKey, new Date(0));
            // Pending/failed/used challenges also spend the permit. Never retry
            // after an ambiguous provider result or a process restart.
            if (lifetime.ipSentAt.length) return null;
          }
          const history = await tx.requestHistory(email, scopeKey, new Date(now.getTime() - 3_600_000));
          const decision = evaluateSendLimits({ ...history, now: now.getTime(), ipMaxPerHour });
          if (decision.allowed) {
            await tx.insertChallenge({ ...challenge, delivery: "pending", ipKey: scopeKey, passwordAttempts: 0 });
          }
          return decision;
        });
        if (!limit) return { status: "unavailable" };
        if (!limit.allowed) return { status: "limited", retryAfterSeconds: limit.retryAfterSeconds };
        try {
          await mailer.send({ to: email, ...renderLoginEmail(publicUrl, token) });
        } catch {
          await repository.transaction(tx => tx.setDelivery(challenge.tokenHash, "failed"));
          return { status: "unavailable" };
        }
        await repository.transaction(tx => tx.setDelivery(challenge.tokenHash, "ready"));
        // No account lookup: new, legacy and verified emails follow the same path.
        return { status: "accepted", message: LOGIN_REQUEST_MESSAGE };
      } catch {
        // Raw provider/repository errors may include credentials or login URLs.
        // Never propagate or log them. A pending challenge cannot be confirmed.
        return { status: "unavailable" };
      }
    },

    async previewLink(token: string) {
      try { return await inspect(token); } catch { return { status: "unavailable" as const }; }
    },

    async confirm(input: {
      token: string;
      name?: string;
      password?: string;
      currentUserId: number | null;
      currentSessionId?: string;
      switchConsent: boolean;
      returnTo?: string;
      request: { method: string; origin: string | undefined; csrfCookie: string | undefined; csrfHeader: string | undefined };
    }): Promise<ConfirmationResult> {
      if (!validConfirmationRequest({ ...input.request, publicUrl })) return { status: "forbidden" };
      const hash = tokenHash(input.token);
      if (!hash) return { status: "invalid" };
      try {
        return await repository.transaction(async tx => {
          const now = clock();
          const challenge = await tx.challengeForUpdate(hash);
          if (!challenge || challenge.delivery !== "ready") return { status: "invalid" };
          const state = inspectLoginChallenge(challenge, input.token, challenge.email, now);
          if (state !== "valid") return { status: state };
          // The adapter must serialize account selection/creation for this email,
          // including when no account row exists yet.
          const account = await tx.accountForUpdate(challenge.email);
          if (input.currentUserId !== null && account?.id !== input.currentUserId && !input.switchConsent) {
            return { status: "consent_required" };
          }
          // The owner explicitly chose mailbox-only proof for ALL accounts.
          // Preserve old IDs, names and password hashes; do not ask for a password.
          const suppliedName = input.name?.trim();
          const name = suppliedName && suppliedName.length <= 120 ? suppliedName : "Пользователь";
          // Recheck expiry after acquiring the account lock.
          const confirmedAt = clock();
          const finalState = inspectLoginChallenge(challenge, input.token, challenge.email, confirmedAt);
          if (finalState !== "valid") return { status: finalState };
          const user = account ?? await tx.createVerifiedAccount(challenge.email, name!, confirmedAt);
          if (account && account.emailVerifiedAt === null) await tx.markEmailVerified(account.id, confirmedAt);
          if (!await tx.consumeChallenge(hash, confirmedAt)) throw new ConsumeConflict();
          // jti for the EXISTING JWT/cookie mechanism, not a parallel login cookie.
          // Only its hash is stored. The HTTP adapter signs/sets the cookie after commit.
          const sessionId = newOpaqueToken();
          await tx.insertSession({
            idHash: hashLoginToken(sessionId), userId: user.id, createdAt: confirmedAt,
            expiresAt: new Date(confirmedAt.getTime() + SESSION_TTL_MS), revokedAt: null,
          });
          if (input.currentUserId !== null && input.currentSessionId) {
            await tx.revokeSession(hashLoginToken(input.currentSessionId), confirmedAt);
          }
          return {
            status: "confirmed", user: { id: user.id, name: user.name, email: user.email },
            sessionId, returnTo: safeReturnPath(input.returnTo, publicUrl), isNew: !account,
          };
        });
      } catch (error) {
        return { status: error instanceof ConsumeConflict ? "used" : "unavailable" };
      }
    },

    async sessionUserId(sessionId: string | undefined): Promise<number | null> {
      if (!sessionId) return null; // Legacy JWTs without a server-backed jti.
      const hash = tokenHash(sessionId);
      if (!hash) return null;
      try {
        const session = await repository.readSession(hash);
        return session && session.revokedAt === null && session.expiresAt.getTime() > clock().getTime()
          ? session.userId : null;
      } catch { return null; }
    },

    async revokeSession(sessionId: string): Promise<boolean> {
      const hash = tokenHash(sessionId);
      if (!hash) return false;
      try {
        await repository.transaction(tx => tx.revokeSession(hash, clock()));
        return true;
      } catch { return false; }
    },
  };
}
