import { createHash, randomBytes } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import { and, desc, eq } from "drizzle-orm";
import {
  CreateSessionResponse,
  CreateSessionBody,
  FinalizeSessionParams,
  FinalizeSessionResponse,
  GetMeResponse,
  GetProjectDocumentParams,
  GetProjectDocumentResponse,
  GetSessionParams,
  GetSessionResponse,
  ListSessionsResponse,
  LoginBody,
  LoginResponse,
  RegisterBody,
  RegisterResponse,
  SendMessageBody,
  SendMessageParams,
  SendMessageResponse,
  SendProjectDocumentBody,
  SendProjectDocumentResponse,
} from "@workspace/api-zod";
import {
  db,
  messagesTable,
  projectDocumentsTable,
  referenceFilesTable,
  requirementSessionsTable,
  usersTable,
} from "@workspace/db";
import { clearSessionCookie, getUserId, setSessionCookie } from "../lib/auth";
import { getProxyApiConfig } from "../lib/proxyapi";
import {
  coerceInterviewState,
  createInitialInterviewState,
  createManagerReply,
  createProjectDocument,
  requestsTechnicalBrief,
  type InterviewState,
} from "../lib/requirements-ai";
import {
  EmailDeliveryError,
  sendProjectDocumentEmail,
  sendWelcomeEmail,
} from "../lib/send-project-document";
import {
  auditSourceHash,
  queueAuditIfEnabled,
} from "../modules/ai-audit/audit-job";

const router: IRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
const allowedReferenceMimeTypes = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function toIso(value: Date): string {
  return value.toISOString();
}

function messageView(message: typeof messagesTable.$inferSelect) {
  const isAssistant = message.role === "assistant";
  return {
    id: message.id,
    role: isAssistant ? "assistant" : "user",
    sender_type: isAssistant ? "bot" : "user",
    sender_label: isAssistant ? "AI-менеджер" : "Вы",
    content: message.content,
    timestamp: toIso(message.timestamp),
  };
}

function finalizedInterviewState(state: InterviewState): InterviewState {
  return {
    ...state,
    response_type: "finalize",
    next_action: "none",
    progress: {
      ...state.progress,
      answered: state.progress.required,
      percent: 100,
    },
    missing_questions: [],
    available_actions: ["continue_editing"],
    ready_to_finalize: true,
  };
}

async function requireUser(req: Request, res: Response): Promise<number | null> {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Требуется вход в аккаунт" });
    return null;
  }
  return userId;
}

async function ownedSession(sessionId: number, userId: number) {
  const [session] = await db
    .select()
    .from(requirementSessionsTable)
    .where(
      and(
        eq(requirementSessionsTable.id, sessionId),
        eq(requirementSessionsTable.userId, userId),
      ),
    );
  return session;
}

async function reopenSessionForEdits(
  session: typeof requirementSessionsTable.$inferSelect,
) {
  if (session.status === "active") return;

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(projectDocumentsTable)
      .set({ status: "draft" })
      .where(eq(projectDocumentsTable.sessionId, session.id));
    await tx
      .update(requirementSessionsTable)
      .set({ status: "active", lastActive: now })
      .where(eq(requirementSessionsTable.id, session.id));
  });
}

async function finalizeRequirementSession(
  session: typeof requirementSessionsTable.$inferSelect,
  userId: number,
  interviewState: InterviewState,
) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) throw new Error("Session owner was not found");

  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, session.id))
    .orderBy(messagesTable.timestamp);
  const document = await createProjectDocument(session.id, user, messages, session.title);
  const [saved] = await db
    .insert(projectDocumentsTable)
    .values({
      sessionId: session.id,
      markdown: document.markdown,
      jsonData: document.jsonData,
      status: "final",
    })
    .onConflictDoUpdate({
      target: projectDocumentsTable.sessionId,
      set: {
        markdown: document.markdown,
        jsonData: document.jsonData,
        status: "final",
      },
    })
    .returning();
  await db
    .update(requirementSessionsTable)
    .set({
      title: document.title,
      status: "final",
      interviewState: finalizedInterviewState(interviewState),
      lastActive: new Date(),
    })
    .where(eq(requirementSessionsTable.id, session.id));
  queueAuditIfEnabled({
    sessionId: session.id,
    projectDocumentId: saved.id,
    tzVersion: auditSourceHash(document.markdown, document.jsonData),
  });

  return { document, saved };
}

async function sessionView(session: typeof requirementSessionsTable.$inferSelect) {
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, session.id));
  const [document] = await db
    .select({ id: projectDocumentsTable.id })
    .from(projectDocumentsTable)
    .where(eq(projectDocumentsTable.sessionId, session.id));
  return {
    id: session.id,
    status: session.status,
    title: session.title,
    summary: session.projectSummary,
    created_at: toIso(session.createdAt),
    last_active: toIso(session.lastActive),
    message_count: messages.length,
    has_document: Boolean(document),
    interview_state:
      session.status === "active"
        ? coerceInterviewState(session.interviewState)
        : finalizedInterviewState(coerceInterviewState(session.interviewState)),
  };
}

router.post("/auth/register", async (req, res): Promise<void> => {
  const body = RegisterBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Проверьте имя и адрес электронной почты" });
    return;
  }

  const email = body.data.email.trim().toLowerCase();
  const [existingUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (existingUser) {
    res.status(409).json({ error: "Этот email уже зарегистрирован. Войдите с паролем." });
    return;
  }

  const password = randomBytes(8).toString("base64url").slice(0, 10);
  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db
    .insert(usersTable)
    .values({ name: body.data.name.trim(), email, passwordHash })
    .returning();
  setSessionCookie(res, user.id);
  void sendWelcomeEmail({ name: user.name, email: user.email, password }).catch((error) => {
    req.log.warn({ err: error }, "Welcome email delivery failed");
  });
  res.status(201).json(
    RegisterResponse.parse({
      user: { id: user.id, name: user.name, email: user.email },
      password,
      is_new: true,
    }),
  );
});

router.post("/transcribe", upload.single("audio"), async (req, res): Promise<void> => {
  const audio = req.file;
  if (!audio) {
    res.status(400).json({ error: "Аудиофайл не найден" });
    return;
  }
  if (!audio.mimetype.startsWith("audio/")) {
    res.status(400).json({ error: "Поддерживаются только аудиофайлы" });
    return;
  }
  const config = getProxyApiConfig();
  if (!config) {
    res.status(503).json({ error: "Сервис транскрибации временно недоступен" });
    return;
  }
  try {
    const formData = new FormData();
    formData.set("model", "gpt-4o-mini-transcribe");
    const audioBytes = new Uint8Array(
      audio.buffer.buffer,
      audio.buffer.byteOffset,
      audio.buffer.byteLength,
    ).slice();
    formData.set(
      "file",
      new Blob([audioBytes], { type: audio.mimetype }),
      audio.originalname || "voice.webm",
    );
    const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: formData,
    });
    if (!response.ok) {
      req.log.warn({ status: response.status }, "Transcription provider rejected audio");
      res.status(502).json({ error: "Не удалось распознать голосовое сообщение" });
      return;
    }
    const data = (await response.json()) as { text?: string };
    res.json({ text: data.text?.trim() ?? "" });
  } catch (error) {
    req.log.error({ err: error }, "Audio transcription failed");
    res.status(502).json({ error: "Не удалось распознать голосовое сообщение" });
  }
});

router.get("/sessions/:id/files", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  const params = GetSessionParams.safeParse(req.params);
  if (!userId) return;
  if (!params.success || !(await ownedSession(params.data.id, userId))) {
    res.status(404).json({ error: "Проект не найден" });
    return;
  }
  const files = await db
    .select({
      id: referenceFilesTable.id,
      originalName: referenceFilesTable.originalName,
      mimeType: referenceFilesTable.mimeType,
      size: referenceFilesTable.size,
      createdAt: referenceFilesTable.createdAt,
    })
    .from(referenceFilesTable)
    .where(eq(referenceFilesTable.sessionId, params.data.id))
    .orderBy(desc(referenceFilesTable.createdAt));
  res.json(files.map((file) => ({
    id: file.id,
    name: file.originalName,
    mime_type: file.mimeType,
    size: file.size,
    created_at: toIso(file.createdAt),
  })));
});

router.post("/sessions/:id/files", upload.single("file"), async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  const params = GetSessionParams.safeParse(req.params);
  const file = req.file;
  if (!userId) return;
  if (!params.success || !(await ownedSession(params.data.id, userId))) {
    res.status(404).json({ error: "Проект не найден" });
    return;
  }
  if (!file || !allowedReferenceMimeTypes.has(file.mimetype)) {
    res.status(400).json({ error: "Поддерживаются PDF, TXT, JSON и изображения PNG, JPG, WEBP" });
    return;
  }
  const [saved] = await db
    .insert(referenceFilesTable)
    .values({
      sessionId: params.data.id,
      userId,
      originalName: file.originalname.slice(0, 240),
      mimeType: file.mimetype,
      size: file.size,
      data: file.buffer.toString("base64"),
    })
    .returning();
  res.status(201).json({
    id: saved.id,
    name: saved.originalName,
    mime_type: saved.mimeType,
    size: saved.size,
    created_at: toIso(saved.createdAt),
  });
});

router.delete("/sessions/:id/files/:fileId", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  const sessionId = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  if (!userId || !Number.isInteger(sessionId) || !Number.isInteger(fileId)) {
    res.status(400).json({ error: "Некорректный идентификатор файла" });
    return;
  }
  if (!(await ownedSession(sessionId, userId))) {
    res.status(404).json({ error: "Проект не найден" });
    return;
  }
  await db
    .delete(referenceFilesTable)
    .where(
      and(
        eq(referenceFilesTable.id, fileId),
        eq(referenceFilesTable.sessionId, sessionId),
        eq(referenceFilesTable.userId, userId),
      ),
    );
  res.status(204).end();
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const body = LoginBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Введите email и пароль" });
    return;
  }

  const email = body.data.email.trim().toLowerCase();
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (!user || !(await bcrypt.compare(body.data.password, user.passwordHash))) {
    res.status(401).json({ error: "Неверный email или пароль" });
    return;
  }

  setSessionCookie(res, user.id);
  res.json(
    LoginResponse.parse({
      user: { id: user.id, name: user.name, email: user.email },
      password: null,
      is_new: false,
    }),
  );
});

router.post("/auth/logout", (_req, res): void => {
  clearSessionCookie(res);
  res.sendStatus(204);
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "Аккаунт не найден" });
    return;
  }
  res.json(GetMeResponse.parse({ id: user.id, name: user.name, email: user.email }));
});

router.get("/sessions", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const sessions = await db
    .select()
    .from(requirementSessionsTable)
    .where(eq(requirementSessionsTable.userId, userId))
    .orderBy(desc(requirementSessionsTable.lastActive));
  const result = await Promise.all(sessions.map(sessionView));
  res.json(ListSessionsResponse.parse(result));
});

router.post("/sessions", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const body = CreateSessionBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Некорректное название проекта" });
    return;
  }
  const interviewState = createInitialInterviewState();
  const [session] = await db
    .insert(requirementSessionsTable)
    .values({
      userId,
      title: body.data.title?.trim() || "Новый проект",
      interviewState,
    })
    .returning();
  const [greeting] = await db
    .insert(messagesTable)
    .values({
      sessionId: session.id,
      role: "assistant",
      content:
        "Здравствуйте! Я AI-менеджер по сбору ТЗ. Расскажите, какой проект вы хотите разработать?",
    })
    .returning();
  const base = await sessionView(session);
  res.status(201).json(
    CreateSessionResponse.parse({ ...base, messages: [messageView(greeting)] }),
  );
});

router.get("/sessions/:id", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const params = GetSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректный идентификатор проекта" });
    return;
  }
  const session = await ownedSession(params.data.id, userId);
  if (!session) {
    res.status(404).json({ error: "Проект не найден" });
    return;
  }
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, session.id))
    .orderBy(messagesTable.timestamp);
  const base = await sessionView(session);
  res.json(GetSessionResponse.parse({ ...base, messages: messages.map(messageView) }));
});

router.post("/sessions/:id/message", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const params = SendMessageParams.safeParse(req.params);
  const body = SendMessageBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Введите сообщение" });
    return;
  }
  const session = await ownedSession(params.data.id, userId);
  if (!session) {
    res.status(404).json({ error: "Проект не найден" });
    return;
  }
  const wasReopened = session.status !== "active";
  if (wasReopened) {
    await reopenSessionForEdits(session);
  }

  const [userMessage] = await db
    .insert(messagesTable)
    .values({ sessionId: session.id, role: "user", content: body.data.content.trim() })
    .returning();

  const previous = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, session.id))
    .orderBy(messagesTable.timestamp);
  const reply = await createManagerReply(previous, {
    wasReopened,
    previousState: coerceInterviewState(session.interviewState),
  });
  const requestedFinalization = requestsTechnicalBrief(userMessage.content);

  if (
    requestedFinalization &&
    reply.interviewState.response_type !== "error" &&
    reply.interviewState.ready_to_finalize
  ) {
    try {
      await finalizeRequirementSession(session, userId, reply.interviewState);
    } catch (error) {
      req.log.warn({ err: error }, "Technical brief generation failed");
      res.status(502).json({ error: "Не удалось сформировать ТЗ. Попробуйте ещё раз через минуту." });
      return;
    }
    const [assistantMessage] = await db
      .insert(messagesTable)
      .values({
        sessionId: session.id,
        role: "assistant",
        content: "ТЗ сформировано по собранным требованиям. Открываю документ для проверки.",
      })
      .returning();
    res.json(
      SendMessageResponse.parse({
        user_message: messageView(userMessage),
        assistant_message: messageView(assistantMessage),
        interview_state: finalizedInterviewState(reply.interviewState),
      }),
    );
    return;
  }

  const [assistantMessage] = await db
    .insert(messagesTable)
    .values({ sessionId: session.id, role: "assistant", content: reply.text })
    .returning();
  const newTitle =
    session.title === "Новый проект"
      ? body.data.content.trim().slice(0, 72)
      : session.title;
  await db
    .update(requirementSessionsTable)
    .set({
      title: newTitle,
      status: "active",
      interviewState: reply.interviewState,
      lastActive: new Date(),
    })
    .where(eq(requirementSessionsTable.id, session.id));
  res.json(
    SendMessageResponse.parse({
      user_message: messageView(userMessage),
      assistant_message: messageView(assistantMessage),
      interview_state: reply.interviewState,
    }),
  );
});

router.post("/sessions/:id/finalize", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const params = FinalizeSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректный идентификатор проекта" });
    return;
  }
  const session = await ownedSession(params.data.id, userId);
  if (!session) {
    res.status(404).json({ error: "Проект не найден" });
    return;
  }
  if (session.status !== "active") {
    res.status(409).json({
      error: "ТЗ уже сформировано. Вернитесь в диалог и добавьте изменения.",
      code: "SESSION_NOT_ACTIVE",
    });
    return;
  }
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, session.id))
    .orderBy(messagesTable.timestamp);
  const assessment = await createManagerReply(messages);
  await db
    .update(requirementSessionsTable)
    .set({ interviewState: assessment.interviewState, lastActive: new Date() })
    .where(eq(requirementSessionsTable.id, session.id));
  if (assessment.interviewState.response_type === "error") {
    res.status(503).json({
      error: "Не удалось проверить полноту требований. Попробуйте ещё раз через минуту.",
    });
    return;
  }
  if (!assessment.interviewState.ready_to_finalize) {
    res.status(409).json({
      error: "Перед сборкой ТЗ нужно заполнить обязательные данные.",
      code: "MISSING_REQUIREMENTS",
      interview_state: assessment.interviewState,
    });
    return;
  }
  let document: Awaited<ReturnType<typeof finalizeRequirementSession>>["document"];
  let saved: Awaited<ReturnType<typeof finalizeRequirementSession>>["saved"];
  try {
    ({ document, saved } = await finalizeRequirementSession(
      session,
      userId,
      assessment.interviewState,
    ));
  } catch (error) {
    req.log.warn({ err: error }, "Technical brief generation failed");
    res.status(502).json({ error: "Не удалось сформировать ТЗ. Попробуйте ещё раз через минуту." });
    return;
  }
  res.json(
    FinalizeSessionResponse.parse({
      session_id: session.id,
      title: document.title,
      markdown: saved.markdown,
      json_data: saved.jsonData,
      status: saved.status,
    }),
  );
});

router.get("/sessions/:id/tz", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const params = GetProjectDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректный идентификатор проекта" });
    return;
  }
  const session = await ownedSession(params.data.id, userId);
  const [document] = await db
    .select()
    .from(projectDocumentsTable)
    .where(eq(projectDocumentsTable.sessionId, params.data.id));
  if (!session || !document) {
    res.status(404).json({ error: "ТЗ пока не сформировано" });
    return;
  }
  res.json(
    GetProjectDocumentResponse.parse({
      session_id: session.id,
      title: session.title,
      markdown: document.markdown,
      json_data: document.jsonData,
      status: document.status,
    }),
  );
});

router.post("/send-tz", async (req, res): Promise<void> => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const body = SendProjectDocumentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Не указан проект" });
    return;
  }
  const session = await ownedSession(body.data.session_id, userId);
  const [document] = await db
    .select()
    .from(projectDocumentsTable)
    .where(eq(projectDocumentsTable.sessionId, body.data.session_id));
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!session || !document || !user) {
    res.status(404).json({ error: "Не удалось найти сформированное ТЗ" });
    return;
  }
  if (session.status === "active" || document.status === "draft") {
    res.status(409).json({ error: "ТЗ изменилось. Сначала соберите обновлённую версию." });
    return;
  }
  if (session.status === "sent" || document.status === "sent") {
    const [updated] = await db
      .update(projectDocumentsTable)
      .set({ status: "sent" })
      .where(eq(projectDocumentsTable.id, document.id))
      .returning();
    await db
      .update(requirementSessionsTable)
      .set({ status: "sent", lastActive: new Date() })
      .where(eq(requirementSessionsTable.id, session.id));
    res.json(
      SendProjectDocumentResponse.parse({
        session_id: session.id,
        title: session.title,
        markdown: updated.markdown,
        json_data: updated.jsonData,
        status: "sent",
      }),
    );
    return;
  }
  try {
    const version = createHash("sha256")
      .update(session.title)
      .update(document.markdown)
      .update(JSON.stringify(document.jsonData))
      .digest("hex");
    await sendProjectDocumentEmail({
      clientName: user.name,
      title: session.title,
      markdown: document.markdown,
      jsonData: document.jsonData,
      idempotencyKey: `project-document-${document.id}-${version}`,
    });
  } catch (error) {
    req.log.error(
      {
        documentId: document.id,
        providerStatus: error instanceof EmailDeliveryError ? error.status : null,
        providerCode: error instanceof EmailDeliveryError ? error.providerCode : null,
        failureKind: error instanceof EmailDeliveryError ? "provider_rejected" : "delivery_failed",
      },
      "Technical brief delivery failed",
    );
    res.status(502).json({
      error:
        error instanceof EmailDeliveryError && error.status === 403
          ? "Почтовый сервис отклонил отправку. Проверьте подтверждение домена отправителя и адрес получателя."
          : "Не удалось отправить ТЗ. Попробуйте позже.",
    });
    return;
  }
  req.log.info({ documentId: document.id, deliveryStatus: "accepted_by_provider" }, "Technical brief submitted to email provider");
  const [updated] = await db
    .update(projectDocumentsTable)
    .set({ status: "sent" })
    .where(eq(projectDocumentsTable.id, document.id))
    .returning();
  await db
    .update(requirementSessionsTable)
    .set({ status: "sent", lastActive: new Date() })
    .where(eq(requirementSessionsTable.id, session.id));
  res.json(
    SendProjectDocumentResponse.parse({
      session_id: session.id,
      title: session.title,
      markdown: updated.markdown,
      json_data: updated.jsonData,
      status: "sent",
    }),
  );
});

export default router;