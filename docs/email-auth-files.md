# Изменённые файлы реализации

Список относится к реализации, включённой только в dev/preview по отдельному разрешению пользователя. Dev-миграция выполнена; production, merge/push/commit и настоящие письма не выполнялись.

## Сервер
- `artifacts/api-server/src/index.ts` — в dev-проверках с отключённой почтой не возобновляет старые аудиты
- `artifacts/api-server/src/app.ts`
- `artifacts/api-server/src/lib/auth.ts`
- `artifacts/api-server/src/lib/send-project-document.ts`
- `artifacts/api-server/src/modules/email-auth/contracts.ts`
- `artifacts/api-server/src/modules/email-auth/service.ts`
- `artifacts/api-server/src/modules/email-auth/postgres-repository.ts` — новый
- `artifacts/api-server/src/modules/email-auth/http.ts` — новый
- `artifacts/api-server/src/modules/email-auth/runtime.ts` — новый
- `artifacts/api-server/src/modules/email-auth/settings.ts` — новый
- `artifacts/api-server/src/routes/requirements.ts`

## Интерфейс
- `artifacts/requirements-manager/index.html`
- `artifacts/requirements-manager/src/App.tsx`
- `artifacts/requirements-manager/src/components/layout.tsx`
- `artifacts/requirements-manager/src/pages/chat.tsx`
- `artifacts/requirements-manager/src/lib/email-auth.ts` — новый
- `artifacts/requirements-manager/src/pages/email-login.tsx` — новый
- `artifacts/requirements-manager/src/pages/email-confirm.tsx` — новый

## Контракт и клиент
- `lib/api-spec/openapi.yaml`
- `lib/api-client-react/src/custom-fetch.ts`
- `lib/api-client-react/src/index.ts`
- `lib/api-client-react/src/generated/api.schemas.ts`
- `lib/api-client-react/src/generated/api.ts`
- `lib/api-zod/src/generated/api.ts`
- `lib/api-zod/src/generated/types/index.ts`
- `lib/api-zod/src/generated/types/confirmEmailLoginBody.ts` — новый
- `lib/api-zod/src/generated/types/emailAuthReply.ts` — новый
- `lib/api-zod/src/generated/types/emailAuthReplyStatus.ts` — новый
- `lib/api-zod/src/generated/types/getEmailCsrf200.ts` — новый
- `lib/api-zod/src/generated/types/inspectEmailLoginBody.ts` — новый
- `lib/api-zod/src/generated/types/requestEmailLoginBody.ts` — новый

## Схема
- `lib/db/src/schema/users.ts`
- `lib/db/src/schema/email-auth.ts` — новые таблицы авторизации
- `lib/db/src/schema/index.ts`
- Ниже — сохранённые материалы предварительного сравнения:
- `lib/db/proposals/verified-email.schema.ts` — новый
- `lib/db/proposals/baseline-review.config.ts` — новый, генерация без подключения
- `lib/db/proposals/review.config.ts` — новый, генерация без подключения

Активная схема обновлена после разрешённой dev-миграции. `lib/db/drizzle.config.ts` и post-merge не изменены.

## Тесты
- `artifacts/api-server/test/email-auth-canary.test.ts` — allowlist, явное согласие и одноразовая квота; провайдер подменён
- `docs/email-auth-preview-mail.md` — подготовка одного настоящего письма, отправка пока заблокирована
- `artifacts/api-server/test/email-auth-postgres.test.ts` — настоящие dev-транзакции и live preview API, только новые синтетические записи
- `artifacts/api-server/test/run-email-auth-postgres.mjs` — отдельный явно включаемый dev-runner, без ключей почты/AI
- `docs/email-auth-dev-results.md` — актуальные результаты
- `artifacts/api-server/test/email-auth.fixture.ts`
- `artifacts/api-server/test/email-auth-service.test.ts`
- `artifacts/api-server/test/email-auth-http.test.ts` — новый
- `artifacts/api-server/test/email-auth-client.test.ts` — новый, четыре конфигурации без реального fetch/БД
- `artifacts/api-server/test/email-auth-offline.test.ts`
- `artifacts/api-server/test/run-email-auth-tests.mjs`

Существующие `security.ts`, `mailer.ts` и чистые тесты безопасности переиспользуются; в текущей реализации не переписывались.

## Документация и служебные файлы
- `README.md`
- `docs/testing-postgresql.md`
- `docs/email-auth-rollout.md` — новый
- `docs/email-auth-publish-preview.json` — новый
- `docs/email-auth-schema-review.sql` — новый, только офлайн-ревью
- `docs/email-auth-files.md` — этот список
- `.gitignore`, `.replitignore` — исключение generated-artifacts
- `.local/tasks/verified-email-login.md` — актуализация фактического состояния
- `.agents/memory/test-database-isolation.md` — уточнение границ разрешений

Сборки и исходные снимки генератора находятся в исключённом `generated-artifacts/`; это не код запуска или автоматические миграции.
