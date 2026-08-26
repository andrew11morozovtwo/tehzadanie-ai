import type { AuditReport, AuditSeverity } from "./types";

const severities = new Set<AuditSeverity>(["P0", "P1", "P2", "P3"]);
const areas = new Set([
  "frontend",
  "backend",
  "database",
  "security",
  "integrations",
  "ux",
  "observability",
  "cost_control",
]);
const changes = new Set(["add", "modify", "deprecate"]);
const requirements = new Set(["required", "optional", "conditional"]);
const owners = new Set(["developer", "prompt_engineer"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function list<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parse);
  return parsed.every((item): item is T => item !== null) ? parsed : null;
}

function severity(value: unknown): AuditSeverity | null {
  return typeof value === "string" && severities.has(value as AuditSeverity)
    ? (value as AuditSeverity)
    : null;
}

function score(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function parseJson(reply: string | null): unknown {
  if (!reply) return null;
  const trimmed = reply
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function parseAuditReport(reply: string | null): AuditReport | null {
  const source = record(parseJson(reply));
  if (!source || source.audit_version !== "1.0") return null;
  const metadata = record(source.audit_metadata);
  const scores = record(source.scores);
  if (!metadata || !scores) return null;

  const parsedScores = {
    overall_score: score(scores.overall_score),
    completeness_score: score(scores.completeness_score),
    clarity_score: score(scores.clarity_score),
    consistency_score: score(scores.consistency_score),
    testability_score: score(scores.testability_score),
    conversation_score: score(scores.conversation_score),
  };
  if (Object.values(parsedScores).some((value) => value === null)) return null;

  const strengths = list(source.strengths, (value) => {
    const item = record(value);
    if (!item) return null;
    const title = text(item.title);
    const evidence = text(item.evidence);
    const itemValue = text(item.value);
    return title && evidence && itemValue ? { title, evidence, value: itemValue } : null;
  });
  const issues = list(source.tz_issues, (value) => {
    const item = record(value);
    if (!item) return null;
    const parsed = {
      severity: severity(item.severity),
      section: text(item.section),
      problem: text(item.problem),
      evidence: text(item.evidence),
      risk: text(item.risk),
      recommendation: text(item.recommendation),
      question_for_client: nullableText(item.question_for_client),
    };
    return Object.values(parsed).slice(0, 6).every(Boolean) ? parsed as AuditReport["tz_issues"][number] : null;
  });
  const missedQuestions = list(source.missed_questions, (value) => {
    const item = record(value);
    if (!item) return null;
    const parsed = {
      topic: text(item.topic),
      why_important: text(item.why_important),
      when_to_ask: text(item.when_to_ask),
      recommended_question_ru: text(item.recommended_question_ru),
      target_json_field: text(item.target_json_field),
    };
    return Object.values(parsed).every(Boolean) ? parsed as AuditReport["missed_questions"][number] : null;
  });
  const weakQuestions = list(source.weak_questions, (value) => {
    const item = record(value);
    if (!item) return null;
    const parsed = {
      original_pattern: text(item.original_pattern),
      problem: text(item.problem),
      improved_question_ru: text(item.improved_question_ru),
      prompt_rule: text(item.prompt_rule),
    };
    return Object.values(parsed).every(Boolean) ? parsed as AuditReport["weak_questions"][number] : null;
  });
  const codeRecommendations = list(source.code_recommendations, (value) => {
    const item = record(value);
    if (!item || !areas.has(String(item.area))) return null;
    const parsed = {
      priority: severity(item.priority),
      area: item.area as AuditReport["code_recommendations"][number]["area"],
      title: text(item.title),
      problem: text(item.problem),
      recommendation: text(item.recommendation),
      expected_effect: text(item.expected_effect),
      success_criterion: text(item.success_criterion),
    };
    if (
      !parsed.priority ||
      !parsed.title ||
      !parsed.problem ||
      !parsed.recommendation ||
      !parsed.expected_effect ||
      !parsed.success_criterion
    ) {
      return null;
    }
    return {
      priority: parsed.priority,
      area: parsed.area,
      title: parsed.title,
      problem: parsed.problem,
      recommendation: parsed.recommendation,
      expected_effect: parsed.expected_effect,
      success_criterion: parsed.success_criterion,
    };
  });
  const promptRecommendations = list(source.prompt_recommendations, (value) => {
    const item = record(value);
    if (!item) return null;
    const parsed = {
      priority: severity(item.priority),
      title: text(item.title),
      problem: text(item.problem),
      prompt_rule: text(item.prompt_rule),
      improved_question_ru: text(item.improved_question_ru),
      expected_effect: text(item.expected_effect),
    };
    return Object.values(parsed).every(Boolean) ? parsed as AuditReport["prompt_recommendations"][number] : null;
  });
  const jsonRecommendations = list(source.json_schema_recommendations, (value) => {
    const item = record(value);
    if (!item || !changes.has(String(item.change_type)) || !requirements.has(String(item.requirement))) return null;
    const parsed = {
      path: text(item.path),
      change_type: item.change_type as "add" | "modify" | "deprecate",
      data_type: text(item.data_type),
      requirement: item.requirement as "required" | "optional" | "conditional",
      reason: text(item.reason),
      example_value: text(item.example_value),
    };
    if (!parsed.path || !parsed.data_type || !parsed.reason || !parsed.example_value) return null;
    return {
      path: parsed.path,
      change_type: parsed.change_type,
      data_type: parsed.data_type,
      requirement: parsed.requirement,
      reason: parsed.reason,
      example_value: parsed.example_value,
    };
  });
  const actionPlan = list(source.action_plan, (value) => {
    const item = record(value);
    if (!item || !owners.has(String(item.owner))) return null;
    const parsed = {
      priority: severity(item.priority),
      action: text(item.action),
      owner: item.owner as "developer" | "prompt_engineer",
      reason: text(item.reason),
      expected_result: text(item.expected_result),
      done_criterion: text(item.done_criterion),
    };
    if (
      !parsed.priority ||
      !parsed.action ||
      !parsed.reason ||
      !parsed.expected_result ||
      !parsed.done_criterion
    ) {
      return null;
    }
    return {
      priority: parsed.priority,
      action: parsed.action,
      owner: parsed.owner,
      reason: parsed.reason,
      expected_result: parsed.expected_result,
      done_criterion: parsed.done_criterion,
    };
  });
  const manualQuestions = list(source.questions_for_manual_review, text);
  const summary = text(source.summary);

  if (
    !summary ||
    !strengths ||
    !issues ||
    !missedQuestions ||
    !weakQuestions ||
    !codeRecommendations ||
    !promptRecommendations ||
    !jsonRecommendations ||
    !actionPlan ||
    actionPlan.length > 10 ||
    !manualQuestions
  ) {
    return null;
  }

  return {
    audit_version: "1.0",
    audit_metadata: {
      session_id: text(metadata.session_id) ?? "",
      session_created_at: text(metadata.session_created_at) ?? "",
      tz_generated_at: text(metadata.tz_generated_at) ?? "",
      project_title: nullableText(metadata.project_title),
      project_type: nullableText(metadata.project_type),
      client_name: text(metadata.client_name) ?? "",
      client_email: text(metadata.client_email) ?? "",
      generated_at: text(metadata.generated_at) ?? "",
      audit_model: text(metadata.audit_model) ?? "",
      audit_prompt_version: text(metadata.audit_prompt_version) ?? "",
      manager_prompt_version: nullableText(metadata.manager_prompt_version),
    },
    scores: parsedScores as AuditReport["scores"],
    summary,
    strengths,
    tz_issues: issues,
    missed_questions: missedQuestions,
    weak_questions: weakQuestions,
    code_recommendations: codeRecommendations,
    prompt_recommendations: promptRecommendations,
    json_schema_recommendations: jsonRecommendations,
    action_plan: actionPlan,
    questions_for_manual_review: manualQuestions,
  };
}