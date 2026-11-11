// REVIEW ONLY: deliberately NOT exported by src/schema/index.ts.
// No active config, post-merge hook or application startup imports this schema.
import { pgTable, serial, text, timestamp, integer, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
export * from "../src/schema/audit-reports";
export * from "../src/schema/messages";
export * from "../src/schema/project-documents";
export * from "../src/schema/reference-files";
export * from "../src/schema/requirement-sessions";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
});

export const emailChallengesTable = pgTable("auth_email_challenges", {
  tokenHash: text("token_hash").primaryKey(),
  email: text("email").notNull(),
  purpose: text("purpose").notNull().default("email_login"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  delivery: text("delivery").notNull().default("pending"),
  ipKey: text("ip_key").notNull(),
  passwordAttempts: integer("password_attempts").notNull().default(0),
}, table => [
  index("auth_email_challenges_email_created_idx").on(table.email, table.createdAt),
  index("auth_email_challenges_ip_created_idx").on(table.ipKey, table.createdAt),
  index("auth_email_challenges_expires_idx").on(table.expiresAt),
  check("auth_email_challenges_delivery_check", sql`${table.delivery} IN ('pending','ready','failed')`),
  check("auth_email_challenges_purpose_check", sql`${table.purpose} = 'email_login'`),
  check("auth_email_challenges_attempts_check", sql`${table.passwordAttempts} >= 0`),
]);

export const authSessionsTable = pgTable("auth_sessions", {
  idHash: text("id_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, table => [
  index("auth_sessions_user_idx").on(table.userId),
  index("auth_sessions_expires_idx").on(table.expiresAt),
]);
