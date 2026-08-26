import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectDocumentsTable } from "./project-documents";
import { requirementSessionsTable } from "./requirement-sessions";

export const auditReportsTable = pgTable(
  "audit_reports",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => requirementSessionsTable.id, { onDelete: "cascade" }),
    projectDocumentId: integer("project_document_id")
      .notNull()
      .references(() => projectDocumentsTable.id, { onDelete: "cascade" }),
    sourceHash: text("source_hash").notNull(),
    status: text("status").notNull().default("queued"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    auditJson: jsonb("audit_json"),
    auditMarkdown: text("audit_markdown"),
    overallScore: integer("overall_score"),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_reports_session_source_hash_unique").on(
      table.sessionId,
      table.sourceHash,
    ),
    index("audit_reports_session_id_index").on(table.sessionId),
    index("audit_reports_project_document_id_index").on(table.projectDocumentId),
    index("audit_reports_status_index").on(table.status),
    index("audit_reports_created_at_index").on(table.createdAt),
  ],
);