import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { requirementSessionsTable } from "./requirement-sessions";
import { usersTable } from "./users";

export const referenceFilesTable = pgTable("reference_files", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => requirementSessionsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  data: text("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});