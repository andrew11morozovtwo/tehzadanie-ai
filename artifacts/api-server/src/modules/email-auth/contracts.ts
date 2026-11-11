import type { LoginChallenge } from "./security";

export type AuthAccount = {
  id: number;
  email: string;
  name: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
};

export type StoredChallenge = LoginChallenge & {
  delivery: "pending" | "ready" | "failed";
  ipKey: string;
  passwordAttempts: number;
};

export type AuthSession = {
  idHash: string;
  userId: number;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

/**
 * The future PostgreSQL adapter MUST lock the affected email/IP and token rows,
 * enforce unique email/hash constraints, and roll back ALL changes on throw.
 * Memory-based tests do not establish these database guarantees.
 */
export interface EmailAuthTransaction {
  lockRequestScope(email: string, ipKey: string): Promise<void>;
  requestHistory(email: string, ipKey: string, since: Date): Promise<{
    emailSentAt: number[]; ipSentAt: number[];
  }>;
  insertChallenge(challenge: StoredChallenge): Promise<void>;
  setDelivery(hash: string, status: "ready" | "failed"): Promise<void>;
  challengeForUpdate(hash: string): Promise<StoredChallenge | null>;
  accountForUpdate(email: string): Promise<AuthAccount | null>;
  reservePasswordAttempt(hash: string, maxAttempts: number): Promise<boolean>;
  createVerifiedAccount(email: string, name: string, at: Date): Promise<AuthAccount>;
  markEmailVerified(userId: number, at: Date): Promise<void>;
  consumeChallenge(hash: string, at: Date): Promise<boolean>;
  insertSession(session: AuthSession): Promise<void>;
  revokeSession(hash: string, at: Date): Promise<void>;
}

export interface EmailAuthRepository {
  transaction<T>(work: (tx: EmailAuthTransaction) => Promise<T>): Promise<T>;
  readChallenge(hash: string): Promise<StoredChallenge | null>;
  readSession(hash: string): Promise<AuthSession | null>;
  readAccountByEmail(email: string): Promise<AuthAccount | null>;
}

export interface LoginMailer {
  // Resolve only if accepted by the provider. This is NOT mailbox verification.
  send(message: { to: string; subject: string; html: string; text: string }): Promise<void>;
}
