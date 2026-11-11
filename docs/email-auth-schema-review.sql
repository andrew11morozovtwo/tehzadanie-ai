-- REVIEW ONLY, NOT AN APPLICATION OR PRODUCTION MIGRATION SCRIPT.
-- Generated offline by drizzle-kit 0.31.10 from current source snapshot to
-- lib/db/proposals/verified-email.schema.ts. No database was queried or modified.
-- This is the exact OFFLINE candidate output, NOT the actual future Publish SQL.
-- Replit-managed production changes MUST use the supported Publish workflow
-- after backup, real schema diff review and separate explicit approval.

CREATE TABLE "auth_sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
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
	CONSTRAINT "auth_email_challenges_delivery_check" CHECK ("auth_email_challenges"."delivery" IN ('pending','ready','failed')),
	CONSTRAINT "auth_email_challenges_purpose_check" CHECK ("auth_email_challenges"."purpose" = 'email_login'),
	CONSTRAINT "auth_email_challenges_attempts_check" CHECK ("auth_email_challenges"."password_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_email_challenges_email_created_idx" ON "auth_email_challenges" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "auth_email_challenges_ip_created_idx" ON "auth_email_challenges" USING btree ("ip_key","created_at");--> statement-breakpoint
CREATE INDEX "auth_email_challenges_expires_idx" ON "auth_email_challenges" USING btree ("expires_at");
