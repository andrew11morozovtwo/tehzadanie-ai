import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { requirementSessionsTable } from "./requirement-sessions";

export const projectDocumentsTable = pgTable("project_documents", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .unique()
    .references(() => requirementSessionsTable.id, { onDelete: "cascade" }),
  jsonData: jsonb("json_data").notNull().default({}),
  markdown: text("markdown").notNull(),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});