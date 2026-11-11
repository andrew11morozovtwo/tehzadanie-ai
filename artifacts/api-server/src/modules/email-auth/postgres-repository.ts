import type { AuthAccount, AuthSession, EmailAuthRepository, EmailAuthTransaction, StoredChallenge } from "./contracts";

type Row = Record<string, unknown>;
export interface AuthSqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
}
export interface AuthSqlPool {
  connect(): Promise<AuthSqlClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
const date = (value: unknown) => value instanceof Date ? value : new Date(String(value));
const nullableDate = (value: unknown) => value == null ? null : date(value);
const accountView = (row: Row): AuthAccount => ({
  id: Number(row.id), name: String(row.name), email: String(row.email),
  passwordHash: row.password_hash == null ? null : String(row.password_hash),
  emailVerifiedAt: nullableDate(row.email_verified_at),
});
const challengeView = (row: Row): StoredChallenge => ({
  email: String(row.email), tokenHash: String(row.token_hash), purpose: "email_login",
  createdAt: date(row.created_at), expiresAt: date(row.expires_at), usedAt: nullableDate(row.used_at),
  delivery: row.delivery as StoredChallenge["delivery"], ipKey: String(row.ip_key),
  passwordAttempts: Number(row.password_attempts),
});

/** No SQL is executed until a method is called; no schema creation or migration. */
export class PostgresEmailAuthRepository implements EmailAuthRepository {
  constructor(private readonly pool: AuthSqlPool) {}

  private async account(query: AuthSqlPool["query"], email: string, lock = false) {
    const result = await query(
      `SELECT id,name,email,password_hash,email_verified_at FROM users
       WHERE lower(btrim(email))=$1 ORDER BY id LIMIT 2${lock ? " FOR UPDATE" : ""}`, [email],
    );
    // Never silently merge or pick one of conflicting historical addresses.
    if (result.rows.length > 1) throw new Error("Conflicting canonical email");
    return result.rows[0] ? accountView(result.rows[0]) : null;
  }
  async readAccountByEmail(email: string) {
    return this.account(this.pool.query.bind(this.pool), email);
  }
  async readChallenge(hash: string) {
    const result = await this.pool.query(
      "SELECT * FROM auth_email_challenges WHERE token_hash=$1 AND purpose='email_login'", [hash],
    );
    return result.rows[0] ? challengeView(result.rows[0]) : null;
  }
  async readSession(hash: string): Promise<AuthSession | null> {
    const { rows } = await this.pool.query(
      `SELECT s.* FROM auth_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.id_hash=$1 AND u.email_verified_at IS NOT NULL`, [hash],
    );
    const row = rows[0];
    return row ? {
      idHash: String(row.id_hash), userId: Number(row.user_id), createdAt: date(row.created_at),
      expiresAt: date(row.expires_at), revokedAt: nullableDate(row.revoked_at),
    } : null;
  }

  async transaction<T>(work: (tx: EmailAuthTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let failed = false;
    const query = client.query.bind(client);
    const lock = async (key: string) => {
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    };
    try {
      await query("BEGIN");
      await query("SET LOCAL lock_timeout='5s'");
      await query("SET LOCAL statement_timeout='10s'");
      const tx: EmailAuthTransaction = {
        lockRequestScope: async (email, ipKey) => {
          for (const key of [`email-auth:email:${email}`, `email-auth:ip:${ipKey}`].sort()) await lock(key);
        },
        requestHistory: async (email, ipKey, since) => {
          const { rows } = await query(
            `SELECT email,ip_key,created_at FROM auth_email_challenges
             WHERE created_at>$3 AND (email=$1 OR ip_key=$2)`, [email, ipKey, since],
          );
          return {
            emailSentAt: rows.filter(r => r.email === email).map(r => date(r.created_at).getTime()),
            ipSentAt: rows.filter(r => r.ip_key === ipKey).map(r => date(r.created_at).getTime()),
          };
        },
        insertChallenge: async row => {
          await query(
            `INSERT INTO auth_email_challenges
             (token_hash,email,purpose,created_at,expires_at,used_at,delivery,ip_key,password_attempts)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [row.tokenHash, row.email, row.purpose, row.createdAt, row.expiresAt, row.usedAt,
              row.delivery, row.ipKey, row.passwordAttempts],
          );
        },
        setDelivery: async (hash, delivery) => {
          const { rows } = await query(
            "UPDATE auth_email_challenges SET delivery=$2 WHERE token_hash=$1 AND delivery='pending' RETURNING token_hash",
            [hash, delivery],
          );
          if (!rows.length) throw new Error("Challenge activation failed");
        },
        challengeForUpdate: async hash => {
          const { rows } = await query(
            "SELECT * FROM auth_email_challenges WHERE token_hash=$1 AND purpose='email_login' FOR UPDATE", [hash],
          );
          return rows[0] ? challengeView(rows[0]) : null;
        },
        accountForUpdate: async email => {
          // Also serialize the missing-row case; a row lock alone cannot do this.
          await lock(`email-auth:email:${email}`);
          return this.account(query, email, true);
        },
        reservePasswordAttempt: async (hash, maximum) => {
          const { rows } = await query(
            `UPDATE auth_email_challenges SET password_attempts=password_attempts+1
             WHERE token_hash=$1 AND password_attempts<$2 RETURNING token_hash`, [hash, maximum],
          );
          return rows.length === 1;
        },
        createVerifiedAccount: async (email, name, at) => {
          const { rows } = await query(
            `INSERT INTO users(name,email,password_hash,email_verified_at)
             VALUES($1,$2,NULL,$3) RETURNING id,name,email,password_hash,email_verified_at`, [name, email, at],
          );
          return accountView(rows[0]);
        },
        markEmailVerified: async (userId, at) => {
          // Preserve an existing, credible verification timestamp.
          await query("UPDATE users SET email_verified_at=COALESCE(email_verified_at,$2) WHERE id=$1", [userId, at]);
        },
        consumeChallenge: async (hash, at) => {
          const { rows } = await query(
            `UPDATE auth_email_challenges SET used_at=$2
             WHERE token_hash=$1 AND used_at IS NULL AND delivery='ready' AND purpose='email_login'
             AND expires_at>GREATEST($2::timestamptz,clock_timestamp()) RETURNING token_hash`, [hash, at],
          );
          return rows.length === 1;
        },
        insertSession: async row => {
          await query(
            "INSERT INTO auth_sessions(id_hash,user_id,created_at,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5)",
            [row.idHash, row.userId, row.createdAt, row.expiresAt, row.revokedAt],
          );
        },
        revokeSession: async (hash, at) => {
          await query("UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE id_hash=$1", [hash, at]);
        },
      };
      const result = await work(tx);
      await query("COMMIT");
      return result;
    } catch (error) {
      try { await query("ROLLBACK"); } catch { failed = true; }
      throw error;
    } finally {
      // Destroy a connection whose rollback failed instead of returning it dirty.
      if (failed && "release" in client) (client.release as (error?: boolean) => void)(true);
      else client.release();
    }
  }
}
