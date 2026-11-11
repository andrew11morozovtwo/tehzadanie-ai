# Публикация входа по ссылке: проверенный комплект

## Состояние перед публикацией

Владелец попросил публикацию и подтвердил выбранное `Recovery window = 7 days` в production. Это подтверждение владельца, не выполненное агентом тестовое восстановление. Перед финальным Publish владелец должен видеть доступную актуальную точку перед выпуском; Restore для проверки не запускать.

Подтверждённый адрес публикации: https://ai-mieniedzhier-sbora-triebovanii.replit.app/.
Read-only проверка managed production: 26 аккаунтов, 28 проектов, 19 документов, 0 конфликтующих групп email по trim/lowercase. Это исходные агрегаты, не содержимое записей.

Настройки **для следующей production-публикации** сохранены отдельно:

```text
EMAIL_AUTH_ENABLED=true
VITE_EMAIL_AUTH_ENABLED=true
EMAIL_AUTH_MAIL_MODE=resend
EMAIL_AUTH_TRANSPORT=connector
EMAIL_AUTH_FROM_EMAIL=login@notify.databotsolution.ru
AUTH_PUBLIC_URL=https://ai-mieniedzhier-sbora-triebovanii.replit.app/
AUTH_IP_MAX_PER_HOUR=60
AUTH_TRUST_PROXY_HOPS=0
```

Домен отправителя проверен через тот же подключённый Resend: verified, sending enabled, click/open tracking off. Используется проверенное подключение, а не неподтверждённый прежний API-ключ. Прочие mail-helper и `RESEND_FROM_EMAIL` не перенастраивались. Значения SESSION_SECRET, DATABASE_URL и других секретов не читались и не менялись. Автоматические/конкурентные тесты в production не запускались, письма агент не отправлял.

IP-лимит с `trust proxy = 0` безопасно не доверяет произвольному X-Forwarded-For, но общий прокси может объединять клиентов в лимит 60 запросов/час. Доверенные proxy hops нельзя увеличивать без проверки топологии.

## Точный полученный штатный SQL-diff

Ниже результат `explainSchemaDiff`, **не ручной скрипт применения**. SQL применяет только штатный Publish, по подтверждению владельца. Проверка не нашла структурных удалений; `maybeNonBackwardsCompatible=true`. Если в Publish появился другой diff, удаление/очистка или предложение overwrite data — остановиться и разобрать его, не подтверждать вслепую.

```sql
CREATE TABLE "auth_email_challenges" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "purpose" text DEFAULT 'email_login' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "delivery" text DEFAULT 'pending' NOT NULL,
  "ip_key" text NOT NULL,
  "password_attempts" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "auth_email_challenges_attempts_check" CHECK (password_attempts >= 0),
  CONSTRAINT "auth_email_challenges_delivery_check" CHECK (delivery = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])),
  CONSTRAINT "auth_email_challenges_purpose_check" CHECK (purpose = 'email_login'::text)
);
CREATE TABLE "auth_sessions" (
  "id_hash" text PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "auth_email_challenges_email_created_idx" ON "auth_email_challenges" USING btree ("email","created_at");
CREATE INDEX "auth_email_challenges_expires_idx" ON "auth_email_challenges" USING btree ("expires_at");
CREATE INDEX "auth_email_challenges_ip_created_idx" ON "auth_email_challenges" USING btree ("ip_key","created_at");
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");
```

Сохраняются email, хеши паролей, ID, имена и все связи проектов/документов. Старым адресам не присваиваются даты подтверждения автоматически. Они записываются только после входа по действительной ссылке. Непосредственный HTTP GET не пишет в БД; страница делает защищённый POST автоматически и ведёт в «Мои ТЗ». Почтовые сканеры, выполняющие JavaScript, могут погасить ссылку.

## Выпуск и ручная проверка

1. Проверить в production-настройках восстановления доступную точку непосредственно перед выпуском, записать время/часовой пояс. Общее окно 7 дней не является результатом тестового восстановления.
2. В Publish просмотреть diff выше. Не выбирать перенос/перезапись dev-данных в production. Автоматическую schema-only миграцию проводит платформа вместе с выпуском кода и сборкой frontend с production-флагом.
3. Возможны краткие блокировки при ALTER TABLE/FK и перерыв во время переключения несовместимой схемы/кода. Нулевой простой не гарантируется.
4. После включения **старые подписанные JWT без серверного sid перестают давать доступ**; все входят заново. SESSION_SECRET не вращается; новые сессии сохраняются между перезапусками.
5. На production `/login` ввести собственный действующий email и запросить письмо. Нажать приватную ссылку с production-доменом — открывается «Мои ТЗ». Для всех аккаунтов пароль и имя не требуются по последнему решению владельца; открытый другой аккаунт переключается только с согласием. Ссылки/токены не присылать в чат.
6. Проверить свои прежние документы, обновить страницу, выйти. Проверка владельцем на собственном аккаунте не заменяется автоматическим тестом с рабочими данными.

## Проверки и ограничения отката

Прошли проверки типов API/frontend, 108 офлайн-тестов с подменённой почтой, production-сборка frontend с включённым email-входом. Ранее в отдельной dev прошли 7 настоящих PostgreSQL/HTTP-проверок и браузерный сценарий на синтетической ссылке; владелец подтвердил получение настоящих писем в preview. В production миграция, доставка и ручной вход ещё **не проверены** — публикацию агент не выполнял.

При проблеме новых входов использовать `EMAIL_AUTH_LOGIN_PAUSED=true`, сохраняя новый серверный контроль сессий. Не переключать EMAIL_AUTH_ENABLED=false: старые JWT снова могли бы дать доступ. Не удалять новые таблицы, пользователей, даты подтверждения или документы. Старый код, требующий пароль, несовместим с новыми passwordless-аккаунтами.

PITR заменяет БД на прежнее состояние и может потерять последующие записи. Восстановление требует отдельно согласованной остановки записей и согласованного отката кода; откат кода сам по себе не восстанавливает production-БД. При ошибке не запускать автоматический destructive rollback, не повторять миграции вручную.
