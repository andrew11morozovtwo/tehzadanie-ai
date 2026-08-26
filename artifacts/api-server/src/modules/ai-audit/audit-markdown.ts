import type { AuditReport } from "./types";

function bullet(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- Нет";
}

export function auditReportMarkdown(report: AuditReport): string {
  const metadata = report.audit_metadata;
  const scores = report.scores;
  return `# Внутренний AI-аудит ТЗ

## Паспорт аудита
- Сессия: ${metadata.session_id}
- Создана: ${metadata.session_created_at}
- ТЗ сформировано: ${metadata.tz_generated_at}
- Проект: ${metadata.project_title ?? "Название не определено"}
- Тип: ${metadata.project_type ?? "Не определён"}
- Заказчик: ${metadata.client_name} (${metadata.client_email})
- Модель аудита: ${metadata.audit_model}
- Версия промпта аудита: ${metadata.audit_prompt_version}
- Версия промпта AI-менеджера: ${metadata.manager_prompt_version ?? "Не хранится"}
- Общая оценка: ${scores.overall_score}/100

## Краткий вывод
${report.summary}

## Оценки качества
- Полнота: ${scores.completeness_score}/100
- Ясность: ${scores.clarity_score}/100
- Согласованность: ${scores.consistency_score}/100
- Проверяемость: ${scores.testability_score}/100
- Качество диалога: ${scores.conversation_score}/100

## Сильные стороны
${report.strengths.map((item) => `- **${item.title}**\n  - Основание: ${item.evidence}\n  - Ценность: ${item.value}`).join("\n") || "- Нет"}

## Проблемы итогового ТЗ
${report.tz_issues.map((item) => `- **${item.severity} · ${item.section}**: ${item.problem}\n  - Основание: ${item.evidence}\n  - Риск: ${item.risk}\n  - Рекомендация: ${item.recommendation}\n  - Вопрос клиенту: ${item.question_for_client ?? "Не требуется"}`).join("\n") || "- Не выявлены"}

## Недостающие вопросы к клиенту
${report.missed_questions.map((item) => `- **${item.topic}**: ${item.why_important}\n  - Когда спросить: ${item.when_to_ask}\n  - Вопрос: ${item.recommended_question_ru}\n  - Поле JSON: ${item.target_json_field}`).join("\n") || "- Нет"}

## Слабые вопросы AI-менеджера
${report.weak_questions.map((item) => `- **Паттерн:** ${item.original_pattern}\n  - Проблема: ${item.problem}\n  - Улучшенный вопрос: ${item.improved_question_ru}\n  - Правило промпта: ${item.prompt_rule}`).join("\n") || "- Нет"}

## Рекомендации по коду и логике
${report.code_recommendations.map((item) => `- **${item.priority} · ${item.area} · ${item.title}**\n  - Проблема: ${item.problem}\n  - Рекомендация: ${item.recommendation}\n  - Эффект: ${item.expected_effect}\n  - Критерий: ${item.success_criterion}`).join("\n") || "- Нет"}

## Рекомендации по системному промпту
${report.prompt_recommendations.map((item) => `- **${item.priority} · ${item.title}**\n  - Проблема: ${item.problem}\n  - Правило: ${item.prompt_rule}\n  - Улучшенный вопрос: ${item.improved_question_ru}\n  - Эффект: ${item.expected_effect}`).join("\n") || "- Нет"}

## Рекомендации по JSON-схеме
${report.json_schema_recommendations.map((item) => `- **${item.change_type} ${item.path}** (${item.data_type}, ${item.requirement})\n  - Причина: ${item.reason}\n  - Пример: ${item.example_value}`).join("\n") || "- Нет"}

## Приоритетный план действий
${report.action_plan.map((item) => `- **${item.priority} · ${item.owner}**: ${item.action}\n  - Причина: ${item.reason}\n  - Результат: ${item.expected_result}\n  - Критерий: ${item.done_criterion}`).join("\n") || "- Нет"}

## Вопросы для ручной проверки
${bullet(report.questions_for_manual_review)}
`;
}