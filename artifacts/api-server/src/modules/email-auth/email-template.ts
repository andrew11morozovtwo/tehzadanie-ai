import { buildConfirmationLink } from "./security";

export const LOGIN_REQUEST_MESSAGE =
  "Если адрес указан верно, письмо со ссылкой для входа скоро придёт. Проверьте также папку “Спам”";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

/** Produces a message only. No provider is called and nothing is logged. */
export function renderLoginEmail(publicUrl: string, token: string) {
  const link = buildConfirmationLink(publicUrl, token);
  return {
    subject: "Подтвердите вход в ТехЗадание.AI",
    text: [
      "Вход в ТехЗадание.AI",
      "Нажмите ссылку, чтобы сразу открыть раздел «Мои ТЗ»:",
      link,
      "Ссылка действует 15 минут и может быть использована один раз.",
      "Если вы не запрашивали вход, проигнорируйте это письмо.",
    ].join("\n\n"),
    html: `<h1>Вход в ТехЗадание.AI</h1><p>Нажмите ссылку, чтобы сразу открыть раздел «Мои ТЗ».</p><p><a href="${escapeHtml(link)}">Войти в Мои ТЗ</a></p><p>Ссылка действует 15 минут и может быть использована один раз.</p><p>Если вы не запрашивали вход, проигнорируйте это письмо.</p>`,
  };
}
