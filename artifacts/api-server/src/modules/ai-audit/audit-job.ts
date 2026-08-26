import { createHash } from "node:crypto";
import { and, eq, lt, or } from "drizzle-orm";
import {
  auditReportsTable,
  db,
  messagesTable,
  projectDocumentsTable,
  referenceFilesTable,
  requirementSessionsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { getProxyApiConfig } from "../../lib/proxyapi";
import { sendInternalEmail } from "../../lib/send-project-document";
import { auditEmailHtml } from "./audit-email-template";
import { auditReportMarkdown } from "./audit-markdown";
import { AUDIT_PROMPT_VERSION, auditSystemPrompt } from "./audit-prompt";
import {
  redactAuditReport,
  redactAuditText,
  redactAuditValue,
} from "./audit-sanitizer";
import { parseAuditReport } from "./audit-schema";
import {
  claimAuditReport,
  completeAuditReport,
  enqueueAuditReport,
  failAuditReport,
  markAuditEmailSent,
  recordAuditAttempt,
  requeueAuditForSession,
  saveAuditResult,
} from "./audit-repository";
import type { AuditPayload, AuditReport } from "./types";

const runningJobs = new Set<number>();
// The configured Replit AI endpoint rejects gpt-5-codex as UNSUPPORTED_MODEL.
// gpt-5.6-terra is supported by its Chat Completions API and was verified end-to-end.
const DEFAULT_AUDIT_MODEL = "gpt-5.6-terra";

function auditConfig() {
  const retries = Number(process.env.AUDIT_MAX_RETRIES ?? "3");
  const maxDialogChars = Number(process.env.AUDIT_MAX_DIALOG_CHARS ?? "60000");
  return {
    enabled: process.env.AUDIT_ENABLED === "true",
    model: process.env.AUDIT_MODEL ?? DEFAULT_AUDIT_MODEL,
    maxRetries: Number.isInteger(retries) ? Math.min(Math.max(retries, 1), 3) : 3,
    maxDialogChars: Number.isInteger(maxDialogChars)
      ? Math.min(Math.max(maxDialogChars, 1000), 60000)
      : 60000,
    developerEmail: process.env.AUDIT_DEVELOPER_EMAIL,
  };
}

export function auditSourceHash(markdown: string, jsonData: unknown): string {
  return createHash("sha256")
    .update(markdown)
    .update(JSON.stringify(jsonData))
    .digest("hex");
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

function limitedConversation<T extends { content: string }>(
  messages: T[],
  maxChars: number,
): { messages: T[]; wasTruncated: boolean } {
  let used = 0;
  const selected: T[] = [];
  for (const message of [...messages].reverse()) {
    if (used >= maxChars) break;
    const allowed = Math.max(maxChars - used, 0);
    selected.push({
      ...message,
      content: message.content.slice(Math.max(message.content.length - allowed, 0)),
    });
    used += message.content.length;
  }
  return { messages: selected.reverse(), wasTruncated: selected.length < messages.length };
}

async function loadAuditPayload(sessionId: number, maxDialogChars: number): Promise<AuditPayload | null> {
  const [session] = await db
    .select()
    .from(requirementSessionsTable)
    .where(eq(requirementSessionsTable.id, sessionId));
  if (!session) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, session.userId));
  const [document] = await db
    .select()
    .from(projectDocumentsTable)
    .where(eq(projectDocumentsTable.sessionId, sessionId));
  if (!user || !document) return null;

  const [messages, files] = await Promise.all([
    db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, sessionId))
      .orderBy(messagesTable.timestamp),
    db
      .select()
      .from(referenceFilesTable)
      .where(eq(referenceFilesTable.sessionId, sessionId)),
  ]);
  const truncatedConversation = limitedConversation(
    messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" as const : "user" as const,
      content: message.content,
      created_at: message.timestamp.toISOString(),
    })),
    maxDialogChars,
  );

  const context = { clientName: user.name, clientEmail: user.email };
  const conversation = truncatedConversation.wasTruncated
    ? [
        {
          role: "assistant" as const,
          content:
            "Серверное примечание аудитору: более ранняя часть диалога сокращена по лимиту контекста. Не делайте выводов о пропущенных репликах.",
          created_at: session.createdAt.toISOString(),
        },
        ...truncatedConversation.messages.map((message) => ({
          ...message,
          content: redactAuditText(message.content, context),
        })),
      ]
    : truncatedConversation.messages.map((message) => ({
        ...message,
        content: redactAuditText(message.content, context),
      }));

  return {
    session: {
      id: String(session.id),
      created_at: session.createdAt.toISOString(),
      finalized_at: document.createdAt.toISOString(),
      language: "ru",
    },
    client: { name: "Клиент", email: maskEmail(user.email) },
    conversation,
    project_json: redactAuditValue(document.jsonData, context) as Record<string, unknown>,
    generated_tz_markdown: redactAuditText(document.markdown, context),
    attachments_metadata: files.map((file) => ({
      name: redactAuditText(file.originalName, context),
      mime_type: file.mimeType,
      url_or_path: `reference_files/${file.id}`,
    })),
  };
}

async function askAuditModel(payload: AuditPayload, model: string): Promise<string | null> {
  const config = getProxyApiConfig();
  if (!config) return null;

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: 8192,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: auditSystemPrompt() },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    });
    if (!response.ok) {
      const responseError = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown; type?: unknown };
      } | null;
      const providerError = responseError?.error;
      logger.warn(
        {
          model,
          statusCode: response.status,
          providerErrorCode: typeof providerError?.code === "string" ? providerError.code : null,
          providerErrorType: typeof providerError?.type === "string" ? providerError.type : null,
          providerErrorMessage:
            typeof providerError?.message === "string"
              ? providerError.message.slice(0, 300)
              : null,
        },
        "AI audit model request was rejected",
      );
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim() ?? null;
    if (!content) {
      logger.warn(
        {
          model,
          hasChoice: Boolean(choice),
          finishReason: choice?.finish_reason ?? null,
        },
        "AI audit model returned no content",
      );
    }
    return content;
  } catch {
    logger.warn({ model }, "AI audit model request failed");
    return null;
  }
}

function auditReplyShape(reply: string | null) {
  if (!reply) return { state: "empty" };
  try {
    const parsed: unknown = JSON.parse(reply);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "json_not_object", length: reply.length };
    }
    const source = parsed as Record<string, unknown>;
    const arrayFields = [
      "strengths",
      "tz_issues",
      "missed_questions",
      "weak_questions",
      "code_recommendations",
      "prompt_recommendations",
      "json_schema_recommendations",
      "action_plan",
      "questions_for_manual_review",
    ];
    return {
      state: "json_object",
      length: reply.length,
      keys: Object.keys(source).sort(),
      arrayLengths: Object.fromEntries(
        arrayFields.map((field) => [
          field,
          Array.isArray(source[field]) ? source[field].length : null,
        ]),
      ),
    };
  } catch {
    return { state: "invalid_json", length: reply.length };
  }
}

function normalizeReport(report: AuditReport, payload: AuditPayload, model: string): AuditReport {
  const project = payload.project_json.project;
  const projectData =
    project && typeof project === "object" && !Array.isArray(project)
      ? (project as Record<string, unknown>)
      : {};
  return {
    ...report,
    audit_metadata: {
      session_id: payload.session.id,
      session_created_at: payload.session.created_at,
      tz_generated_at: payload.session.finalized_at,
      project_title: typeof projectData.title === "string" ? projectData.title : null,
      project_type: typeof projectData.type === "string" ? projectData.type : null,
      client_name: payload.client.name,
      client_email: payload.client.email,
      generated_at: new Date().toISOString(),
      audit_model: model,
      audit_prompt_version: AUDIT_PROMPT_VERSION,
      manager_prompt_version: null,
    },
  };
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runAuditReport(reportId: number): Promise<void> {
  if (runningJobs.has(reportId)) return;
  runningJobs.add(reportId);
  try {
    let claimed;
    try {
      claimed = await claimAuditReport(reportId);
    } catch (error) {
      logger.error({ err: error, auditReportId: reportId }, "AI audit could not claim a job");
      return;
    }
    if (!claimed) return;
    const config = auditConfig();
    let emailWasSent = Boolean(claimed.emailSentAt);

    for (let attempt = claimed.retryCount + 1; attempt <= config.maxRetries; attempt += 1) {
      try {
        await recordAuditAttempt(reportId, attempt);
        if (!config.developerEmail) throw new Error("AUDIT_DEVELOPER_EMAIL is not configured");
        const payload = await loadAuditPayload(claimed.sessionId, config.maxDialogChars);
        if (!payload) throw new Error("Audit source data is not available");
        const reply = await askAuditModel(payload, claimed.model);
        const parsed = parseAuditReport(reply);
        if (!parsed) {
          logger.warn(
            { auditReportId: reportId, response: auditReplyShape(reply) },
            "AI audit response did not match the report schema",
          );
          throw new Error("Audit model did not return a valid report");
        }

        const report = redactAuditReport(
          normalizeReport(parsed, payload, claimed.model),
          { clientName: "", clientEmail: "" },
        );
        const markdown = auditReportMarkdown(report);
        await saveAuditResult({
          reportId,
          auditJson: report as unknown as Record<string, unknown>,
          auditMarkdown: markdown,
          overallScore: report.scores.overall_score,
        });
        if (!emailWasSent) {
          await sendInternalEmail({
            recipient: config.developerEmail,
            subject: `AI-аудит ТЗ: ${report.audit_metadata.project_title ?? `сессия ${claimed.sessionId}`}`,
            html: auditEmailHtml(report, markdown),
            idempotencyKey: `audit-report-${reportId}`,
          });
          await markAuditEmailSent(reportId);
          emailWasSent = true;
        }
        await completeAuditReport(reportId);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown audit error";
        if (attempt >= config.maxRetries) {
          await failAuditReport(reportId, message);
          logger.error({ err: error, auditReportId: reportId }, "AI audit failed");
          return;
        }
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  } catch (error) {
    logger.error({ err: error, auditReportId: reportId }, "AI audit worker crashed");
  } finally {
    runningJobs.delete(reportId);
  }
}

export function queueAuditIfEnabled(input: {
  sessionId: number;
  projectDocumentId: number;
  tzVersion: string;
}): void {
  const config = auditConfig();
  if (!config.enabled) return;

  void enqueueAuditReport({
    sessionId: input.sessionId,
    projectDocumentId: input.projectDocumentId,
    sourceHash: input.tzVersion,
    model: config.model,
    promptVersion: AUDIT_PROMPT_VERSION,
  })
    .then((report) => {
      if (report?.status === "queued") setImmediate(() => void runAuditReport(report.id));
    })
    .catch((error) => logger.error({ err: error, sessionId: input.sessionId }, "AI audit enqueue failed"));
}

export async function retryAuditForSession(sessionId: number): Promise<boolean> {
  const config = auditConfig();
  if (!config.enabled) return false;
  const [document] = await db
    .select()
    .from(projectDocumentsTable)
    .where(eq(projectDocumentsTable.sessionId, sessionId));
  if (!document) return false;

  const report = await requeueAuditForSession({
    sessionId,
    sourceHash: auditSourceHash(document.markdown, document.jsonData),
    model: config.model,
    promptVersion: AUDIT_PROMPT_VERSION,
  });
  if (!report) return false;
  setImmediate(() => void runAuditReport(report.id));
  return true;
}

export async function resumePendingAudits(): Promise<void> {
  const config = auditConfig();
  if (!config.enabled) return;

  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const pending = await db
    .select()
    .from(auditReportsTable)
    .where(
      or(
        eq(auditReportsTable.status, "queued"),
        and(
          eq(auditReportsTable.status, "processing"),
          lt(auditReportsTable.startedAt, staleBefore),
        ),
      ),
    )
    .limit(25);

  for (const report of pending) {
    if (report.status === "processing") {
      await db
        .update(auditReportsTable)
        .set({ status: "queued", errorMessage: "Recovered after interrupted worker" })
        .where(eq(auditReportsTable.id, report.id));
    }
    setImmediate(() => void runAuditReport(report.id));
  }
}