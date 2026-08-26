import { getProxyApiConfig } from "./proxyapi";

type ChatMessage = {
  role: string;
  content: string;
};

export type InterviewFieldKey =
  | "goal"
  | "users"
  | "main_scenario"
  | "mvp_features"
  | "data"
  | "platform"
  | "integrations"
  | "constraints"
  | "success_criteria";

export type InterviewResponseType =
  | "ask_question"
  | "confirm"
  | "request_missing"
  | "offer_finalize"
  | "finalize"
  | "error"
  | "continue_editing";

export type InterviewAction =
  | "continue_interview"
  | "show_missing"
  | "save_draft"
  | "finalize"
  | "retry"
  | "continue_editing";

export type InterviewState = {
  response_type: InterviewResponseType;
  next_action:
    | "continue_interview"
    | "show_missing"
    | "save_draft"
    | "finalize"
    | "retry"
    | "continue_editing"
    | "none";
  progress: {
    answered: number;
    required: number;
    percent: number;
    questions_asked: number;
    max_questions: number;
  };
  missing_questions: Array<{
    key: InterviewFieldKey;
    title: string;
    question: string;
  }>;
  available_actions: InterviewAction[];
  ready_to_finalize: boolean;
};

export type ManagerReply = {
  text: string;
  interviewState: InterviewState;
};

type Scenario = {
  name: string;
  steps: string[];
};

type TechnicalBrief = {
  project: {
    title: string;
    type: string;
    goal: string;
    problem_to_solve: string;
    target_audience: string[];
    success_criteria: string;
  };
  scope: string[];
  user_scenarios: Scenario[];
  functional_requirements: string[];
  non_functional_requirements: string[];
  integrations: string[];
  data_and_storage: string[];
  design: string[];
  constraints: string[];
  error_handling: string[];
  acceptance_criteria: string[];
  open_questions: string[];
};

export class TechnicalBriefGenerationError extends Error {
  constructor() {
    super("The AI provider did not return a valid structured technical brief");
    this.name = "TechnicalBriefGenerationError";
  }
}

const DEFAULT_MAX_QUESTIONS = 10;
const interviewFields: Array<{
  key: InterviewFieldKey;
  title: string;
  question: string;
  fallbackPattern: RegExp;
}> = [
  {
    key: "goal",
    title: "Цель и проблема проекта",
    question: "Какую проблему должен решить продукт и зачем он нужен заказчику?",
    fallbackPattern: /цел|проблем|задач|нужен|помо[гч]|реша/iu,
  },
  {
    key: "users",
    title: "Целевые пользователи и роли",
    question: "Кто будет пользоваться продуктом и какие роли нужны?",
    fallbackPattern: /пользовател|клиент|заказчик|сотрудник|админ|роль|аудитори/iu,
  },
  {
    key: "main_scenario",
    title: "Главный пользовательский сценарий",
    question: "Как выглядит главный путь пользователя от входа до полезного результата?",
    fallbackPattern: /сценари|шаг|вход|переход|нажима|получа|результат/iu,
  },
  {
    key: "mvp_features",
    title: "Функции первой версии",
    question: "Какие функции обязательно должны войти в первую версию?",
    fallbackPattern: /функц|первая верси|mvp|должен|можно|созда|редакт|отправ/iu,
  },
  {
    key: "data",
    title: "Данные и хранение",
    question: "Какие данные, файлы или историю действий нужно хранить?",
    fallbackPattern: /данн|хран|файл|истори|баз|запис/iu,
  },
  {
    key: "platform",
    title: "Платформа",
    question: "На какой платформе должен работать продукт: web, mobile или другой вариант?",
    fallbackPattern: /web|веб|mobile|мобил|ios|android|браузер|платформ/iu,
  },
  {
    key: "integrations",
    title: "Интеграции",
    question: "Какие внешние сервисы нужны? Если интеграций не будет, так и укажите.",
    fallbackPattern: /интеграц|api|сервис|crm|telegram|телеграм|почт|плат[её]ж|не нужн/iu,
  },
  {
    key: "constraints",
    title: "Критичные ограничения",
    question: "Какие сроки, бюджет, требования безопасности или другие ограничения критичны?",
    fallbackPattern: /срок|бюджет|огранич|безопас|скорост|нагруз|персональн|офлайн/iu,
  },
  {
    key: "success_criteria",
    title: "Критерий успеха",
    question: "Что для заказчика будет означать, что проект успешно решает задачу?",
    fallbackPattern: /успех|успеш|критери|метрик|результат|конверси|эконом|сократ|увелич/iu,
  },
];

const finishRequestPattern =
  /(?:где\s+(?:тз|техническ(?:ое|ого)\s+задан)|(?:собери|собрать|сформируй|сформировать|подготовь|подготовить|сделай|сделать)\s+(?:тз|техническ(?:ое|ого)\s+задан)|покажи\s+(?:тз|документ))/iu;
const finishInterviewPattern =
  /(?:это\s+(?:вс[её]|всё)|достаточно|больше\s+(?:нечего|ничего)|законч(?:или|ить)|последн[а-яё]*\s+вопрос)/iu;
const saveDraftPattern =
  /(?:сохран(?:и|ить).*(?:позднее|потом|черновик)|продолж(?:у|ить)\s+(?:позднее|потом))/iu;
const continueInterviewPattern =
  /(?:продолж(?:им|ить|ай)|задай\s+(?:ещ[её]|еще)|добав(?:ь|ить)\s+(?:ещ[её]|еще))/iu;
const discussOpenQuestionsPattern =
  /(?:открыт(?:ые|ых)\s+вопрос|нужно\s+(?:их\s+)?(?:тоже\s+)?обсуд|остал(?:ись|ись)\s+вопрос|есть\s+ещ[её]\s+вопрос)/iu;
const finalizeOfferTextPattern =
  /(?:собрать\s+(?:тз|техническое\s+задание)|тз\s+можно\s+собрать|оформить\s+тз)/iu;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function userTurns(history: ChatMessage[]): ChatMessage[] {
  return history.filter((message) => message.role === "user");
}

export function requestsTechnicalBrief(content: string): boolean {
  return finishRequestPattern.test(content);
}

function readyReply(): string {
  return "Основные требования зафиксированы. ТЗ можно собрать уже сейчас — нажмите «Собрать ТЗ» вверху чата или напишите «собери ТЗ».";
}

function managerSystemPrompt(): string {
  return [
    "Ты опытный AI-менеджер по сбору требований на разработку.",
    "Проанализируй весь диалог и верни строго один JSON-объект без Markdown.",
    "covered_fields содержит только обязательные темы, по которым пользователь уже дал конкретный ответ. Явное «нет» для интеграций или ограничений считается ответом.",
    `Допустимые ключи covered_fields: ${interviewFields.map((field) => field.key).join(", ")}.`,
    'Формат: {"reply":"","covered_fields":[]}.',
    "reply — дружелюбный деловой ответ на русском. Если есть пробелы, задай ровно один короткий вопрос по самому важному пробелу. Не повторяй уже известное и не выдумывай факты.",
    "Если пользователь просит продолжить интервью, обсудить открытые вопросы или говорит, что вопросы ещё остались, не предлагай собирать ТЗ: задай ровно один следующий уточняющий вопрос.",
  ].join(" ");
}

function chatCompletionPayload(
  system: string,
  messages: ChatMessage[],
  maxCompletionTokens: number,
  jsonObject = false,
) {
  return {
    model: "gpt-5.6-luna",
    max_completion_tokens: maxCompletionTokens,
    ...(jsonObject ? { response_format: { type: "json_object" } } : {}),
    messages: [
      { role: "system", content: system },
      ...messages.slice(-36).map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
    ],
  };
}

async function askModel(
  system: string,
  messages: ChatMessage[],
  maxCompletionTokens: number,
  jsonObject = false,
): Promise<string | null> {
  const config = getProxyApiConfig();
  if (!config) return null;

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chatCompletionPayload(system, messages, maxCompletionTokens, jsonObject)),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

function substantiveUserTurns(history: ChatMessage[]): ChatMessage[] {
  return userTurns(history).filter((message) => {
    const content = normalizeText(message.content);
    return (
      content.length >= 4 &&
      !requestsTechnicalBrief(content) &&
      !finishInterviewPattern.test(content) &&
      !saveDraftPattern.test(content) &&
      !continueInterviewPattern.test(content)
    );
  });
}

function inferCoveredFields(history: ChatMessage[]): InterviewFieldKey[] {
  const transcript = substantiveUserTurns(history)
    .map((message) => message.content)
    .join(" ");
  return interviewFields
    .filter((field) => field.fallbackPattern.test(transcript))
    .map((field) => field.key);
}

function parseCoveredFields(value: unknown): InterviewFieldKey[] | null {
  if (!Array.isArray(value)) return null;
  const allowed = new Set(interviewFields.map((field) => field.key));
  const parsed = value.filter(
    (item): item is InterviewFieldKey =>
      typeof item === "string" && allowed.has(item as InterviewFieldKey),
  );
  return parsed.length === value.length ? [...new Set(parsed)] : null;
}

function responseState(
  history: ChatMessage[],
  coveredFields: InterviewFieldKey[],
  responseType: InterviewResponseType,
): InterviewState {
  const covered = new Set(coveredFields);
  const missingQuestions = interviewFields
    .filter((field) => !covered.has(field.key))
    .map(({ key, title, question }) => ({ key, title, question }));
  const answered = interviewFields.length - missingQuestions.length;
  const readyToFinalize = missingQuestions.length === 0;
  const progress = {
    answered,
    required: interviewFields.length,
    percent: Math.round((answered / interviewFields.length) * 100),
    questions_asked: substantiveUserTurns(history).length,
    max_questions: DEFAULT_MAX_QUESTIONS,
  };

  if (responseType === "error") {
    return {
      response_type: responseType,
      next_action: "retry",
      progress,
      missing_questions: missingQuestions,
      available_actions: ["retry", "save_draft"],
      ready_to_finalize: readyToFinalize,
    };
  }
  if (responseType === "confirm") {
    return {
      response_type: responseType,
      next_action: "save_draft",
      progress,
      missing_questions: missingQuestions,
      available_actions: readyToFinalize
        ? ["finalize", "save_draft"]
        : ["continue_interview", "show_missing", "save_draft"],
      ready_to_finalize: readyToFinalize,
    };
  }
  if (responseType === "finalize" || responseType === "offer_finalize") {
    return {
      response_type: responseType,
      next_action: "finalize",
      progress,
      missing_questions: missingQuestions,
      available_actions: ["finalize", "save_draft"],
      ready_to_finalize: readyToFinalize,
    };
  }
  if (responseType === "request_missing") {
    return {
      response_type: responseType,
      next_action: "show_missing",
      progress,
      missing_questions: missingQuestions,
      available_actions: ["continue_interview", "show_missing", "save_draft"],
      ready_to_finalize: readyToFinalize,
    };
  }

  return {
    response_type: responseType,
    next_action: responseType === "continue_editing" ? "continue_editing" : "continue_interview",
    progress,
    missing_questions: missingQuestions,
    available_actions: ["continue_interview", "show_missing", "save_draft"],
    ready_to_finalize: readyToFinalize,
  };
}

export function createInitialInterviewState(): InterviewState {
  return responseState([], [], "ask_question");
}

export function coerceInterviewState(value: unknown): InterviewState {
  const source = record(value);
  const progress = record(source.progress);
  if (
    typeof source.response_type !== "string" ||
    typeof source.next_action !== "string" ||
    typeof source.ready_to_finalize !== "boolean" ||
    !Array.isArray(source.missing_questions) ||
    !Array.isArray(source.available_actions) ||
    typeof progress.answered !== "number" ||
    typeof progress.required !== "number" ||
    typeof progress.percent !== "number" ||
    typeof progress.questions_asked !== "number" ||
    typeof progress.max_questions !== "number"
  ) {
    return createInitialInterviewState();
  }
  return value as InterviewState;
}

function missingReply(state: InterviewState): string {
  const titles = state.missing_questions.map((item) => item.title.toLowerCase());
  const preview = titles.slice(0, 3).join(", ");
  const rest = titles.length > 3 ? ` и ещё ${titles.length - 3}` : "";
  return `Пока не могу собрать финальное ТЗ: нужно уточнить ${preview}${rest}. Выберите «Продолжить вопросы» или «Сохранить и продолжить позднее».`;
}

export async function createManagerReply(
  history: ChatMessage[],
  options: { wasReopened?: boolean; previousState?: InterviewState } = {},
): Promise<ManagerReply> {
  const lastUserMessage = [...history].reverse().find((message) => message.role === "user");
  const lastContent = lastUserMessage?.content ?? "";
  if (saveDraftPattern.test(lastContent) && options.previousState) {
    const missingKeys = new Set(
      options.previousState.missing_questions.map((question) => question.key),
    );
    const coveredFields = interviewFields
      .filter((field) => !missingKeys.has(field.key))
      .map((field) => field.key);
    const state = responseState(history, coveredFields, "confirm");
    return {
      text: "Черновик требований сохранён. Проект останется активным — вы сможете продолжить с этого места позднее.",
      interviewState: state,
    };
  }

  const modelReply = await askModel(managerSystemPrompt(), history, 900, true);
  const parsed = record(parseJsonReply(modelReply));
  const coveredFields = parseCoveredFields(parsed.covered_fields);

  if (!modelReply || !coveredFields) {
    const state = responseState(history, inferCoveredFields(history), "error");
    return {
      text: "AI-менеджер временно недоступен. Ваше сообщение сохранено — повторите попытку чуть позже.",
      interviewState: state,
    };
  }

  const provisionalState = responseState(history, coveredFields, "ask_question");
  const requestedContinuation =
    continueInterviewPattern.test(lastContent) ||
    discussOpenQuestionsPattern.test(lastContent);
  const reachedQuestionLimit =
    provisionalState.progress.questions_asked >= DEFAULT_MAX_QUESTIONS &&
    !requestedContinuation;
  const requestedFinish =
    requestsTechnicalBrief(lastContent) || finishInterviewPattern.test(lastContent);

  if (saveDraftPattern.test(lastContent)) {
    const state = responseState(history, coveredFields, "confirm");
    return {
      text: "Черновик требований сохранён. Проект останется активным — вы сможете продолжить с этого места позднее.",
      interviewState: state,
    };
  }

  if (requestedContinuation) {
    const responseType: InterviewResponseType = options.wasReopened
      ? "continue_editing"
      : "ask_question";
    const state = responseState(history, coveredFields, responseType);
    const generatedText = requiredString(parsed.reply);
    return {
      text:
        generatedText && !finalizeOfferTextPattern.test(generatedText)
          ? generatedText
          : "Хорошо, давайте разберём оставшиеся открытые вопросы. Какой из них обсудим первым?",
      interviewState: state,
    };
  }

  if (provisionalState.ready_to_finalize) {
    const responseType: InterviewResponseType = requestedFinish
      ? "finalize"
      : "offer_finalize";
    return {
      text: readyReply(),
      interviewState: responseState(history, coveredFields, responseType),
    };
  }

  if (requestedFinish || reachedQuestionLimit) {
    const state = responseState(history, coveredFields, "request_missing");
    return { text: missingReply(state), interviewState: state };
  }

  const responseType: InterviewResponseType = options.wasReopened
    ? "continue_editing"
    : "ask_question";
  const state = responseState(history, coveredFields, responseType);
  const generatedText = requiredString(parsed.reply);
  return {
    text: generatedText ?? state.missing_questions[0]?.question ?? missingReply(state),
    interviewState: state,
  };
}

function extractTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content;
  if (!firstUserMessage) return "Новый проект";
  const clipped = normalizeText(firstUserMessage).slice(0, 72);
  return clipped || "Новый проект";
}

function requiredStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result = value
    .filter((item): item is string => typeof item === "string")
    .map(normalizeText)
    .filter(Boolean);
  return result.length === value.length ? [...new Set(result)] : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && normalizeText(value) ? normalizeText(value) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredScenarios(value: unknown): Scenario[] | null {
  if (!Array.isArray(value)) return null;
  const result: Scenario[] = [];
  for (const item of value) {
    const scenario = record(item);
    const name = requiredString(scenario.name);
    const steps = requiredStrings(scenario.steps);
    if (!name || !steps?.length) return null;
    result.push({ name, steps });
  }
  return result;
}

function parseTechnicalBrief(value: unknown): TechnicalBrief | null {
  const source = record(value);
  const project = record(source.project);
  const title = requiredString(project.title)?.slice(0, 120);
  const type = requiredString(project.type);
  const goal = requiredString(project.goal);
  const problemToSolve = requiredString(project.problem_to_solve);
  const targetAudience = requiredStrings(project.target_audience);
  const successCriteria = requiredString(project.success_criteria);
  const scope = requiredStrings(source.scope);
  const userScenarios = requiredScenarios(source.user_scenarios);
  const functionalRequirements = requiredStrings(source.functional_requirements);
  const nonFunctionalRequirements = requiredStrings(source.non_functional_requirements);
  const integrations = requiredStrings(source.integrations);
  const dataAndStorage = requiredStrings(source.data_and_storage);
  const design = requiredStrings(source.design);
  const constraints = requiredStrings(source.constraints);
  const errorHandling = requiredStrings(source.error_handling);
  const acceptanceCriteria = requiredStrings(source.acceptance_criteria);
  const openQuestions = requiredStrings(source.open_questions);

  if (
    !title ||
    !type ||
    !goal ||
    !problemToSolve ||
    !targetAudience ||
    !successCriteria ||
    !scope ||
    !userScenarios ||
    !functionalRequirements?.length ||
    !nonFunctionalRequirements ||
    !integrations ||
    !dataAndStorage ||
    !design ||
    !constraints ||
    !errorHandling?.length ||
    !acceptanceCriteria?.length ||
    !openQuestions
  ) {
    return null;
  }

  return {
    project: {
      title,
      type,
      goal,
      problem_to_solve: problemToSolve,
      target_audience: targetAudience,
      success_criteria: successCriteria,
    },
    scope,
    user_scenarios: userScenarios,
    functional_requirements: functionalRequirements,
    non_functional_requirements: nonFunctionalRequirements,
    integrations,
    data_and_storage: dataAndStorage,
    design,
    constraints,
    error_handling: errorHandling,
    acceptance_criteria: acceptanceCriteria,
    open_questions: openQuestions,
  };
}

function parseJsonReply(reply: string | null): unknown {
  if (!reply) return null;
  const withoutFences = reply
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    return null;
  }
}

function bullets(items: string[], empty = "Не уточнено"): string {
  return (items.length ? items : [empty]).map((item) => `- ${item}`).join("\n");
}

function scenarioMarkdown(items: Scenario[]): string {
  if (!items.length) return "- Не уточнено";
  return items
    .map(
      (scenario, index) =>
        `${index + 1}. **${scenario.name}**\n${scenario.steps
          .map((step, stepIndex) => `   ${stepIndex + 1}. ${step}`)
          .join("\n")}`,
    )
    .join("\n");
}

function toMarkdown(client: { name: string; email: string }, brief: TechnicalBrief): string {
  return `# Техническое задание

## 1. Проект
**Название:** ${brief.project.title}

**Тип:** ${brief.project.type}

**Цель:** ${brief.project.goal}

**Проблема, которую решает продукт:** ${brief.project.problem_to_solve}

**Целевая аудитория:**
${bullets(brief.project.target_audience)}

**Критерий успеха:** ${brief.project.success_criteria}

## 2. Границы первой версии
${bullets(brief.scope)}

## 3. Пользовательские сценарии
${scenarioMarkdown(brief.user_scenarios)}

## 4. Функциональные требования
${bullets(brief.functional_requirements)}

## 5. Нефункциональные требования
${bullets(brief.non_functional_requirements)}

## 6. Интеграции
${bullets(brief.integrations)}

## 7. Данные и хранение
${bullets(brief.data_and_storage)}

## 8. Дизайн и интерфейс
${bullets(brief.design)}

## 9. Ограничения
${bullets(brief.constraints)}

## 10. Обработка ошибок
${bullets(brief.error_handling)}

## 11. Критерии готовности
${bullets(brief.acceptance_criteria)}

## 12. Открытые вопросы
${bullets(brief.open_questions, "Открытых вопросов нет.")}

---
**Заказчик:** ${client.name} — ${client.email}`;
}

function documentSystemPrompt(): string {
  return [
    "Ты системный аналитик. На основе диалога подготовь точное ТЗ для команды разработки.",
    "Отвечай строго одним JSON-объектом без Markdown и пояснений.",
    "Не копируй диалог и не придумывай факты. Сформулируй конкретные требования на русском.",
    "Неизвестные детали вынеси в open_questions. Не пиши шаблонные фразы вроде «требует уточнения» в других разделах.",
    "Сценарии должны быть объектами {name, steps}; остальные списки — массивы строк.",
    'Используй ровно эту схему: {"project":{"title":"","type":"","goal":"","problem_to_solve":"","target_audience":[],"success_criteria":""},"scope":[],"user_scenarios":[{"name":"","steps":[]}],"functional_requirements":[],"non_functional_requirements":[],"integrations":[],"data_and_storage":[],"design":[],"constraints":[],"error_handling":[],"acceptance_criteria":[],"open_questions":[]}.',
  ].join(" ");
}

export async function createProjectDocument(
  sessionId: number,
  client: { name: string; email: string },
  messages: ChatMessage[],
  sessionTitle?: string,
) {
  const transcript = messages
    .map((message) => `${message.role === "assistant" ? "Менеджер" : "Клиент"}: ${message.content}`)
    .join("\n");
  const documentMessages = [{ role: "user", content: `Диалог:\n${transcript}` }];
  const reply = await askModel(documentSystemPrompt(), documentMessages, 8192, true);
  let brief = parseTechnicalBrief(parseJsonReply(reply));

  if (!brief) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const retryPrompt = [
      documentSystemPrompt(),
      "Это повторная попытка. Верни полный объект даже для неуточнённых деталей, используя open_questions.",
      "Проверь перед ответом, что все поля схемы присутствуют, строки не пустые, а все списки действительно являются массивами.",
    ].join(" ");
    const retryReply = await askModel(retryPrompt, documentMessages, 8192, true);
    brief = parseTechnicalBrief(parseJsonReply(retryReply));
  }

  if (!brief) throw new TechnicalBriefGenerationError();
  const generatedSessionTitle = extractTitle(messages);
  if (
    sessionTitle &&
    sessionTitle !== "Новый проект" &&
    sessionTitle !== generatedSessionTitle
  ) {
    brief.project.title = sessionTitle.slice(0, 120);
  }
  const jsonData = {
    client_info: {
      name: client.name,
      email: client.email,
      contact_preference: "email",
    },
    ...brief,
    tz_generated_at: new Date().toISOString(),
    session_id: String(sessionId),
  };

  return {
    title: brief.project.title,
    markdown: toMarkdown(client, brief),
    jsonData,
  };
}