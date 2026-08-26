export type AuditSeverity = "P0" | "P1" | "P2" | "P3";

export type AuditPayload = {
  session: {
    id: string;
    created_at: string;
    finalized_at: string;
    language: "ru" | "en" | "unknown";
  };
  client: { name: string; email: string };
  conversation: Array<{
    role: "user" | "assistant";
    content: string;
    created_at: string;
  }>;
  project_json: Record<string, unknown>;
  generated_tz_markdown: string;
  attachments_metadata: Array<{
    name: string;
    mime_type: string;
    url_or_path: string;
  }>;
};

export type AuditReport = {
  audit_version: "1.0";
  audit_metadata: {
    session_id: string;
    session_created_at: string;
    tz_generated_at: string;
    project_title: string | null;
    project_type: string | null;
    client_name: string;
    client_email: string;
    generated_at: string;
    audit_model: string;
    audit_prompt_version: string;
    manager_prompt_version: string | null;
  };
  scores: {
    overall_score: number;
    completeness_score: number;
    clarity_score: number;
    consistency_score: number;
    testability_score: number;
    conversation_score: number;
  };
  summary: string;
  strengths: Array<{ title: string; evidence: string; value: string }>;
  tz_issues: Array<{
    severity: AuditSeverity;
    section: string;
    problem: string;
    evidence: string;
    risk: string;
    recommendation: string;
    question_for_client: string | null;
  }>;
  missed_questions: Array<{
    topic: string;
    why_important: string;
    when_to_ask: string;
    recommended_question_ru: string;
    target_json_field: string;
  }>;
  weak_questions: Array<{
    original_pattern: string;
    problem: string;
    improved_question_ru: string;
    prompt_rule: string;
  }>;
  code_recommendations: Array<{
    priority: AuditSeverity;
    area: "frontend" | "backend" | "database" | "security" | "integrations" | "ux" | "observability" | "cost_control";
    title: string;
    problem: string;
    recommendation: string;
    expected_effect: string;
    success_criterion: string;
  }>;
  prompt_recommendations: Array<{
    priority: AuditSeverity;
    title: string;
    problem: string;
    prompt_rule: string;
    improved_question_ru: string;
    expected_effect: string;
  }>;
  json_schema_recommendations: Array<{
    path: string;
    change_type: "add" | "modify" | "deprecate";
    data_type: string;
    requirement: "required" | "optional" | "conditional";
    reason: string;
    example_value: string;
  }>;
  action_plan: Array<{
    priority: AuditSeverity;
    action: string;
    owner: "developer" | "prompt_engineer";
    reason: string;
    expected_result: string;
    done_criterion: string;
  }>;
  questions_for_manual_review: string[];
};