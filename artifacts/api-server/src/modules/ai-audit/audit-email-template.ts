import type { AuditReport } from "./types";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function list(items: string[]): string {
  if (!items.length) return "<li>Нет</li>";
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

export function auditEmailHtml(report: AuditReport, auditMarkdown: string): string {
  const issues = report.tz_issues
    .map(
      (issue) =>
        `<li><strong>${escapeHtml(issue.severity)} · ${escapeHtml(issue.section)}</strong><br />${escapeHtml(issue.problem)}<br /><em>Рекомендация:</em> ${escapeHtml(issue.recommendation)}</li>`,
    )
    .join("");
  const actions = report.action_plan
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.priority)} · ${escapeHtml(item.owner)}</strong>: ${escapeHtml(item.action)}<br /><em>Критерий:</em> ${escapeHtml(item.done_criterion)}</li>`,
    )
    .join("");

  return `<h1>Внутренний AI-аудит ТЗ</h1>
<p><strong>Проект:</strong> ${escapeHtml(report.audit_metadata.project_title ?? "Название не определено")}<br />
<strong>Сессия:</strong> ${escapeHtml(report.audit_metadata.session_id)}<br />
<strong>Заказчик:</strong> ${escapeHtml(report.audit_metadata.client_name)} · ${escapeHtml(report.audit_metadata.client_email)}<br />
<strong>Создано:</strong> ${escapeHtml(report.audit_metadata.session_created_at)}<br />
<strong>ТЗ сформировано:</strong> ${escapeHtml(report.audit_metadata.tz_generated_at)}<br />
<strong>Модель:</strong> ${escapeHtml(report.audit_metadata.audit_model)}<br />
<strong>Общая оценка:</strong> ${report.scores.overall_score}/100</p>
<h2>Краткий вывод</h2><p>${escapeHtml(report.summary)}</p>
<h2>Оценки</h2>
<ul>
  <li>Полнота: ${report.scores.completeness_score}/100</li>
  <li>Ясность: ${report.scores.clarity_score}/100</li>
  <li>Согласованность: ${report.scores.consistency_score}/100</li>
  <li>Проверяемость: ${report.scores.testability_score}/100</li>
  <li>Качество диалога: ${report.scores.conversation_score}/100</li>
</ul>
<h2>Проблемы ТЗ</h2><ul>${issues || "<li>Критичных проблем не выявлено</li>"}</ul>
<h2>Приоритетный план действий</h2><ul>${actions || "<li>Нет</li>"}</ul>
<h2>Вопросы для ручной проверки</h2><ul>${list(report.questions_for_manual_review)}</ul>
<hr />
<h2>Полный отчёт</h2><pre style="white-space:pre-wrap;font-family:ui-monospace,monospace">${escapeHtml(auditMarkdown)}</pre>`;
}