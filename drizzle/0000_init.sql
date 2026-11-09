CREATE TYPE "public"."operator_status" AS ENUM('active', 'sacked', 'left');--> statement-breakpoint
CREATE TYPE "public"."return_reason" AS ENUM('reassigned', 'operator_left', 'tricycle_retired', 'other');--> statement-breakpoint
CREATE TYPE "public"."service_interval" AS ENUM('fortnightly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."tricycle_status" AS ENUM('in_stock', 'issued', 'off_road', 'retired');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'manager', 'assistant_manager', 'supervisor', 'operator');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tricycle_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"issued_on" date NOT NULL,
	"returned_on" date,
	"return_reason" "return_reason",
	"return_note" text,
	"issued_by" uuid NOT NULL,
	"returned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignments_return_after_issue" CHECK ("assignments"."returned_on" IS NULL OR "assignments"."returned_on" >= "assignments"."issued_on")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"actor_role" "user_role",
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_rates_positive" CHECK ("balance_rates"."amount_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "login_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ip" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"address" text,
	"licence_number" text,
	"guarantor_name" text,
	"guarantor_phone" text,
	"guarantor_address" text,
	"status" "operator_status" DEFAULT 'active' NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_phone_unique" UNIQUE("phone"),
	CONSTRAINT "operators_user_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tricycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_number" text NOT NULL,
	"code_number" text NOT NULL,
	"chassis_number" text,
	"engine_number" text,
	"purchased_on" date NOT NULL,
	"purchase_cost_kobo" bigint,
	"service_interval" "service_interval" NOT NULL,
	"service_cycle_start" date NOT NULL,
	"status" "tricycle_status" DEFAULT 'in_stock' NOT NULL,
	"retired_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tricycles_registration_unique" UNIQUE("registration_number"),
	CONSTRAINT "tricycles_code_unique" UNIQUE("code_number"),
	CONSTRAINT "tricycles_cost_not_negative" CHECK ("tricycles"."purchase_cost_kobo" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"credential_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_returned_by_users_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_rates" ADD CONSTRAINT "balance_rates_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_rates" ADD CONSTRAINT "balance_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignments_tricycle_idx" ON "assignments" USING btree ("tricycle_id");--> statement-breakpoint
CREATE INDEX "assignments_operator_idx" ON "assignments" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_occurred_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "balance_rates_lookup_idx" ON "balance_rates" USING btree ("assignment_id","effective_from");--> statement-breakpoint
CREATE INDEX "login_failures_ip_at_idx" ON "login_failures" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tricycles_chassis_unique" ON "tricycles" USING btree ("chassis_number") WHERE "tricycles"."chassis_number" IS NOT NULL;