import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BriefQualityError, parseFindings, reviewAndReviseBrief, type QualityFinding,
} from "../src/lib/brief-quality";
import { createProjectDocument } from "../src/lib/requirements-ai";

const brief = () => ({
  project: {
    title: "Математический задачник", type: "Веб-сайт", goal: "Практика математики",
    problem_to_solve: "Помочь освоить задачи", target_audience: ["Ученики 1–4 классов"],
    success_criteria: "Переход на платный тариф",
  },
  scope: ["Три бесплатные задачи", "Адаптация сложности"],
  user_scenarios: [{ name: "Решение", steps: ["Получить задачу", "Отправить ответ"] }],
  functional_requirements: ["Система принимает ответ ученика и показывает результат проверки."],
  non_functional_requirements: [], integrations: ["ЮKassa"], data_and_storage: ["Профиль"],
  design: ["Оранжевые тона"], constraints: ["Три бесплатные задачи"],
  error_handling: ["При исчерпанном лимите следующая задача не выдаётся."],
  acceptance_criteria: ["При исчерпанном лимите запрос задачи отклоняется."],
  open_questions: [],
});
const finding = (overrides = {}): QualityFinding => ({
  id: "Q1", severity: "critical", section: "Адаптация сложности",
  problem: "Не определено правило изменения сложности",
  source: "missing_information", evidence: "В интервью правило не задано",
  recommendation: "Уточнить правило у заказчика",
  clarification_question: "Как изменяется сложность после правильного ответа?",
  ...overrides,
});
const parse = (v: unknown) => {
  const b = v as ReturnType<typeof brief> | null;
  return b && Array.isArray(b.open_questions) ? b : null;
};
const resolution = (overrides = {}) => ({
  finding_id: "Q1", status: "open_question",
  reason: "Алгоритм не согласован", question: "Как изменяется сложность после правильного ответа?",
  ...overrides,
});

test("ordered inspection and revision retain critical unresolved questions", async () => {
  const calls: { system: string; input: string; tokens: number; timeout: number }[] = [];
  const result = await reviewAndReviseBrief({
    transcript: "Клиент: нужны три задачи в день и адаптация сложности",
    draft: brief(), documentInstructions: "Сохрани схему", parseBrief: parse,
    request: async (system, input, tokens, timeout) => {
      calls.push({ system, input, tokens, timeout });
      return JSON.stringify(calls.length === 1
        ? { findings: [finding()] }
        : { brief: brief(), resolutions: [resolution()] });
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].system.includes("инспектор"));
  assert.ok(calls[1].system.includes("финальный редактор"));
  assert.ok(JSON.parse(calls[1].input).findings[0].evidence);
  assert.ok(calls.every(c => c.timeout > 0 && c.timeout <= 90_000 && c.tokens <= 12000));
  assert.match(result.brief.open_questions[0], /Критично для реализации/);
  assert.deepEqual(result.brief.scope, brief().scope);
});

test("empty findings still require final editor", async () => {
  let calls = 0;
  await reviewAndReviseBrief({
    transcript: "Данные", draft: brief(), documentInstructions: "", parseBrief: parse,
    request: async () => JSON.stringify(++calls === 1
      ? { findings: [] } : { brief: brief(), resolutions: [] }),
  });
  assert.equal(calls, 2);
});

for (const invalid of [
  null, { findings: {} }, { findings: [finding(), finding()] },
  { findings: [finding({ severity: "unknown" })] },
  { findings: [finding({ severity: ["critical"] })] },
  { findings: [finding({ source: ["draft"] })] },
  { findings: [finding({ evidence: "" })] },
  { findings: [finding({ clarification_question: null })] },
  { findings: Array.from({ length: 41 }, (_, i) => finding({ id: `Q${i}` })) },
]) {
  test(`invalid inspection fails closed (${JSON.stringify(invalid).slice(0, 60)})`, async () => {
    assert.equal(parseFindings(invalid), null);
    let calls = 0;
    await assert.rejects(reviewAndReviseBrief({
      transcript: "", draft: brief(), documentInstructions: "", parseBrief: parse,
      request: async () => { calls++; return JSON.stringify(invalid); },
    }), (e: unknown) => e instanceof BriefQualityError && e.stage === "inspection");
    assert.equal(calls, 1);
  });
}

for (const resolutions of [
  [], [resolution(), resolution()], [resolution({ finding_id: "Q2" })],
  [resolution({ reason: "" })], [resolution({ question: null })],
  [resolution({ status: "fixed", question: null })],
]) {
  test(`invalid revision cannot silently discard findings (${JSON.stringify(resolutions).slice(0, 70)})`, async () => {
    let calls = 0;
    await assert.rejects(reviewAndReviseBrief({
      transcript: "", draft: brief(), documentInstructions: "", parseBrief: parse,
      request: async () => JSON.stringify(++calls === 1
        ? { findings: [finding()] } : { brief: brief(), resolutions }),
    }), (e: unknown) => e instanceof BriefQualityError && e.stage === "revision");
    assert.equal(calls, 2);
  });
}

test("editor can reject an incorrect critique with explicit evidence", async () => {
  let calls = 0;
  const result = await reviewAndReviseBrief({
    transcript: "Клиент: родительский кабинет не нужен",
    draft: brief(), documentInstructions: "", parseBrief: parse,
    request: async () => JSON.stringify(++calls === 1
      ? { findings: [finding({ problem: "Нет кабинета родителя" })] }
      : { brief: brief(), resolutions: [resolution({
        status: "not_applicable", question: null, reason: "Клиент явно отказался: родительский кабинет не нужен",
      })] }),
  });
  assert.equal(result.brief.open_questions.length, 0);
  assert.equal(result.resolutions[0].status, "not_applicable");
});

test("confirmed omission is repaired and tracked", async () => {
  let calls = 0;
  const corrected = brief();
  corrected.functional_requirements.push("Без активного платного тарифа загрузка задач недоступна.");
  const result = await reviewAndReviseBrief({
    transcript: "Клиент: загрузка задач только на платном тарифе",
    draft: brief(), documentInstructions: "", parseBrief: parse,
    request: async () => JSON.stringify(++calls === 1
      ? { findings: [finding({
        source: "interview", clarification_question: null,
        evidence: "Клиент: загрузка задач только на платном тарифе",
        problem: "Пропущено ограничение загрузки",
      })] }
      : { brief: corrected, resolutions: [resolution({
        status: "fixed", question: null, reason: "Добавлено ограничение загрузки из интервью",
      })] }),
  });
  assert.equal(result.brief.functional_requirements.length, 2);
  assert.equal(result.resolutions[0].status, "fixed");
});

test("full document path uses only ProxyAPI and publishes revised, not draft content", async () => {
  const originalFetch = globalThis.fetch;
  // Only dummy credentials are used; no real provider request occurs.
  process.env.PROXYAPI_KEY = "test-placeholder";
  process.env.PROXYAPI_BASE_URL = "https://api.proxyapi.ru/openai/v1";
  const corrected = brief();
  corrected.functional_requirements = ["Исправленный результат финального редактора"];
  const replies = [brief(), { findings: [] }, { brief: corrected, resolutions: [] }];
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.proxyapi.ru/openai/v1/chat/completions");
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.response_format.type, "json_object");
    return Response.json({ choices: [{ message: { content: JSON.stringify(replies[calls++]) } }] });
  };
  try {
    const result = await createProjectDocument(1, { name: "Тест", email: "test@example.com" }, [
      { role: "user", content: "Веб-задачник. Три бесплатные задачи в день." },
    ], "Задачник");
    assert.equal(calls, 3);
    assert.match(result.markdown, /Исправленный результат финального редактора/);
    assert.equal(result.title, "Задачник");
    assert.equal(result.jsonData.session_id, "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider failure during inspection never returns an unreviewed document", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.PROXYAPI_KEY = "test-placeholder";
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ choices: [{ message: { content: JSON.stringify(brief()) } }] })
    : new Response("", { status: 503 });
  try {
    await assert.rejects(
      createProjectDocument(1, { name: "Тест", email: "test@example.com" }, []),
      (e: unknown) => e instanceof BriefQualityError && e.stage === "inspection",
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid final brief fails instead of returning draft", async () => {
  let calls = 0;
  await assert.rejects(reviewAndReviseBrief({
    transcript: "", draft: brief(), documentInstructions: "", parseBrief: parse,
    request: async () => JSON.stringify(++calls === 1
      ? { findings: [] } : { brief: null, resolutions: [] }),
  }), (e: unknown) => e instanceof BriefQualityError && e.stage === "revision");
  assert.equal(calls, 2);
});

test("invalid draft retries once before inspection, without looping the critic", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PROXYAPI_KEY = "test-placeholder";
  let calls = 0;
  const replies = [null, brief(), { findings: [] }, { brief: brief(), resolutions: [] }];
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify(replies[calls++]) } }],
  });
  try {
    await createProjectDocument(1, { name: "Тест", email: "test@example.com" }, []);
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("timeouts in revision fail closed and are not retried automatically", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PROXYAPI_KEY = "test-placeholder";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 3) throw new DOMException("Timed out", "TimeoutError");
    return Response.json({
      choices: [{ message: { content: JSON.stringify(calls === 1 ? brief() : { findings: [] }) } }],
    });
  };
  try {
    await assert.rejects(
      createProjectDocument(1, { name: "Тест", email: "test@example.com" }, []),
      (e: unknown) => e instanceof BriefQualityError && e.stage === "revision",
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
