import type {
  AuthAccount, AuthSession, EmailAuthRepository, EmailAuthTransaction, StoredChallenge,
} from "../src/modules/email-auth/contracts";

// Test-only, in-memory serialized transactions with rollback snapshots.
// This is NOT a PostgreSQL adapter and proves no database locking guarantees.
export class MemoryEmailAuthRepository implements EmailAuthRepository {
  state = {
    accounts: [] as AuthAccount[],
    challenges: [] as StoredChallenge[],
    sessions: [] as AuthSession[],
  };
  calls = 0;
  failSessionInsert = false;
  failConsume = false;
  private tail: Promise<void> = Promise.resolve();

  async readChallenge(hash: string) {
    return structuredClone(this.state.challenges.find(c => c.tokenHash === hash) ?? null);
  }
  async readSession(hash: string) {
    return structuredClone(this.state.sessions.find(s => s.idHash === hash) ?? null);
  }
  async readAccountByEmail(email: string) {
    return structuredClone(this.state.accounts.find(a => a.email === email) ?? null);
  }
  async transaction<T>(work: (tx: EmailAuthTransaction) => Promise<T>): Promise<T> {
    this.calls++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const before = structuredClone(this.state);
    const tx: EmailAuthTransaction = {
      lockRequestScope: async () => {},
      requestHistory: async (email, ipKey, since) => {
        const recent = this.state.challenges.filter(c => c.createdAt >= since);
        return {
          emailSentAt: recent.filter(c => c.email === email).map(c => c.createdAt.getTime()),
          ipSentAt: recent.filter(c => c.ipKey === ipKey).map(c => c.createdAt.getTime()),
        };
      },
      insertChallenge: async challenge => { this.state.challenges.push(structuredClone(challenge)); },
      setDelivery: async (hash, status) => {
        const row = this.state.challenges.find(c => c.tokenHash === hash);
        if (!row) throw new Error("Missing challenge");
        row.delivery = status;
      },
      challengeForUpdate: async hash => this.readChallenge(hash),
      accountForUpdate: async email => structuredClone(this.state.accounts.find(a => a.email === email) ?? null),
      reservePasswordAttempt: async (hash, maxAttempts) => {
        const row = this.state.challenges.find(c => c.tokenHash === hash);
        if (!row || row.passwordAttempts >= maxAttempts) return false;
        row.passwordAttempts++;
        return true;
      },
      createVerifiedAccount: async (email, name, at) => {
        if (this.state.accounts.some(a => a.email === email)) throw new Error("Duplicate email");
        const account = {
          id: Math.max(0, ...this.state.accounts.map(a => a.id)) + 1,
          name, email, emailVerifiedAt: at, passwordHash: null,
        };
        this.state.accounts.push(account);
        return structuredClone(account);
      },
      markEmailVerified: async (userId, at) => {
        const row = this.state.accounts.find(a => a.id === userId);
        if (!row) throw new Error("Missing user");
        row.emailVerifiedAt = at;
      },
      consumeChallenge: async (hash, at) => {
        const row = this.state.challenges.find(c => c.tokenHash === hash);
        if (this.failConsume || !row || row.usedAt || row.expiresAt <= at || row.delivery !== "ready") return false;
        row.usedAt = at;
        return true;
      },
      insertSession: async session => {
        if (this.failSessionInsert) throw new Error("Simulated insert failure");
        this.state.sessions.push(structuredClone(session));
      },
      revokeSession: async (hash, at) => {
        const row = this.state.sessions.find(s => s.idHash === hash);
        if (row) row.revokedAt = at;
      },
    };
    try {
      return await work(tx);
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      release();
    }
  }
}
