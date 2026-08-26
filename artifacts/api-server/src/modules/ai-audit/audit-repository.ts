import { and, eq } from "drizzle-orm";
import {
  auditReportsTable,
  db,
  projectDocumentsTable,
} from "@workspace/db";

export type EnqueueAuditInput = {
  sessionId: number;
  projectDocumentId: number;
  sourceHash: string;
  model: string;
  promptVersion: string;
};

export async function enqueueAuditReport(input: EnqueueAuditInput) {
  const [created] = await db
    .insert(auditReportsTable)
    .values({
      sessionId: input.sessionId,
      projectDocumentId: input.projectDocumentId,
      sourceHash: input.sourceHash,
      model: input.model,
      promptVersion: input.promptVersion,
      status: "queued",
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [existing] = await db
    .select()
    .from(auditReportsTable)
    .where(
      and(
        eq(auditReportsTable.sessionId, input.sessionId),
        eq(auditReportsTable.sourceHash, input.sourceHash),
      ),
    );
  return existing;
}

export async function claimAuditReport(reportId: number) {
  const [claimed] = await db
    .update(auditReportsTable)
    .set({ status: "processing", startedAt: new Date(), errorMessage: null })
    .where(
      and(
        eq(auditReportsTable.id, reportId),
        eq(auditReportsTable.status, "queued"),
      ),
    )
    .returning();
  return claimed;
}

export async function recordAuditAttempt(reportId: number, retryCount: number) {
  await db
    .update(auditReportsTable)
    .set({ retryCount })
    .where(eq(auditReportsTable.id, reportId));
}

export async function saveAuditResult(input: {
  reportId: number;
  auditJson: Record<string, unknown>;
  auditMarkdown: string;
  overallScore: number;
}) {
  await db
    .update(auditReportsTable)
    .set({
      auditJson: input.auditJson,
      auditMarkdown: input.auditMarkdown,
      overallScore: input.overallScore,
    })
    .where(eq(auditReportsTable.id, input.reportId));
}

export async function completeAuditReport(reportId: number) {
  await db
    .update(auditReportsTable)
    .set({
      status: "completed",
      completedAt: new Date(),
      errorMessage: null,
    })
    .where(eq(auditReportsTable.id, reportId));
}

export async function markAuditEmailSent(reportId: number) {
  await db
    .update(auditReportsTable)
    .set({ emailSentAt: new Date() })
    .where(eq(auditReportsTable.id, reportId));
}

export async function failAuditReport(reportId: number, errorMessage: string) {
  await db
    .update(auditReportsTable)
    .set({ status: "failed", errorMessage: errorMessage.slice(0, 1000) })
    .where(eq(auditReportsTable.id, reportId));
}

export async function requeueAuditForSession(input: {
  sessionId: number;
  sourceHash: string;
  model: string;
  promptVersion: string;
}) {
  const [document] = await db
    .select()
    .from(projectDocumentsTable)
    .where(eq(projectDocumentsTable.sessionId, input.sessionId));
  if (!document) return null;

  const existing = await enqueueAuditReport({
    sessionId: input.sessionId,
    projectDocumentId: document.id,
    sourceHash: input.sourceHash,
    model: input.model,
    promptVersion: input.promptVersion,
  });
  if (!existing || existing.status === "completed") return null;

  const [requeued] = await db
    .update(auditReportsTable)
    .set({
      status: "queued",
      retryCount: 0,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(auditReportsTable.id, existing.id))
    .returning();
  return requeued;
}