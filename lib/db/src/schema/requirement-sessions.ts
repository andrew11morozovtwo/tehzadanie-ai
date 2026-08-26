import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const requirementSessionsTable = pgTable("requirement_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Новый проект"),
  projectSummary: text("project_summary"),
  status: text("status").notNull().default("active"),
  interviewState: jsonb("interview_state")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastActive: timestamp("last_active", { withTimezone: true })
    .notNull()
    .defaultNow(),
});