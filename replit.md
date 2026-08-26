# ТехЗадание.AI

AI-менеджер, который помогает заказчику собрать требования к продукту в чате, подготовить ТЗ и передать его разработчику.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `SESSION_SECRET`, `DEVELOPER_EMAIL`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — контракт API и источник генерации типов.
- `lib/db/src/schema/` — таблицы пользователей, проектов, сообщений и ТЗ.
- `artifacts/api-server/src/routes/requirements.ts` — API приложения.
- `artifacts/requirements-manager/src/` — mobile-first интерфейс.

## Architecture decisions

- Аутентификация использует короткоживущую HTTP-only cookie с JWT, а пароли хешируются bcrypt.
- Resend подключен через Replit Connector; адрес получателя ТЗ задается переменной `DEVELOPER_EMAIL`.
- По умолчанию AI работает через Replit AI Integrations, но сервер поддерживает OpenAI-совместимый ProxyAPI как запасной провайдер.

## Product

- Регистрация и безопасный повторный вход.
- Диалоговый сбор требований, голосовая транскрибация, референсы и генерация ТЗ.
- Предпросмотр Markdown/JSON и отправка на email разработчика.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
