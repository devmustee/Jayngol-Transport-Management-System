CREATE TYPE "public"."charge_type" AS ENUM('daily_balance', 'penalty', 'loan');--> statement-breakpoint
CREATE TYPE "public"."dismissal_status" AS ENUM('flagged', 'resolved', 'confirmed', 'reinstated');--> statement-breakpoint
CREATE TYPE "public"."late_outcome" AS ENUM('on_time', 'fined', 'capped');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'transfer', 'pos');--> statement-breakpoint
CREATE TYPE "public"."sms_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."violation_status" AS ENUM('proposed', 'confirmed', 'rejected', 'waived');--> statement-breakpoint
ALTER TYPE "public"."return_reason" ADD VALUE 'sacked' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "cash_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"custodian_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"expected_kobo" bigint NOT NULL,
	"counted_kobo" bigint NOT NULL,
	"explanation" text,
	"closed_by" uuid NOT NULL,
	"closed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"custodian_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"business_date" date NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charge_voids" (
	"charge_id" uuid PRIMARY KEY NOT NULL,
	"voided_by" uuid,
	"reason" text NOT NULL,
	"voided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" charge_type NOT NULL,
	"operator_id" uuid NOT NULL,
	"tricycle_id" uuid,
	"assignment_id" uuid,
	"amount_kobo" bigint NOT NULL,
	"business_date" date NOT NULL,
	"due_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charges_positive" CHECK ("charges"."amount_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"status" "dismissal_status" NOT NULL,
	"unpaid_days" integer NOT NULL,
	"flagged_on" date NOT NULL,
	"cleared_by" uuid,
	"clear_reason" text,
	"confirmed_by" uuid,
	"confirmed_on" date,
	"reinstated_by" uuid,
	"reinstated_on" date,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"job" text NOT NULL,
	"business_date" date NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_runs_job_business_date_pk" PRIMARY KEY("job","business_date")
);
--> statement-breakpoint
CREATE TABLE "late_evaluations" (
	"charge_id" uuid PRIMARY KEY NOT NULL,
	"outcome" "late_outcome" NOT NULL,
	"evaluated_on" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "non_collection_days" (
	"business_date" date PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	CONSTRAINT "allocations_positive" CHECK ("payment_allocations"."amount_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_reversals" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"reversed_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"reversed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"received_by" uuid NOT NULL,
	"tricycle_present" boolean,
	"receipt_number" text NOT NULL,
	"client_id" uuid NOT NULL,
	"backdate_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_receipt_unique" UNIQUE("receipt_number"),
	CONSTRAINT "payments_client_unique" UNIQUE("client_id"),
	CONSTRAINT "payments_positive" CHECK ("payments"."amount_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"code" text NOT NULL,
	"effective_from" date NOT NULL,
	"name" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	CONSTRAINT "rules_code_effective_from_pk" PRIMARY KEY("code","effective_from")
);
--> statement-breakpoint
CREATE TABLE "sms_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_phone" text NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL,
	"status" "sms_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_code" text NOT NULL,
	"operator_id" uuid NOT NULL,
	"tricycle_id" uuid,
	"occurred_on" date NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"status" "violation_status" NOT NULL,
	"occurrence_key" text NOT NULL,
	"source_charge_id" uuid,
	"charge_id" uuid,
	"raised_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "one_charge_per_offence" UNIQUE("occurrence_key")
);
--> statement-breakpoint
ALTER TABLE "cash_closes" ADD CONSTRAINT "cash_closes_custodian_id_users_id_fk" FOREIGN KEY ("custodian_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closes" ADD CONSTRAINT "cash_closes_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_custodian_id_users_id_fk" FOREIGN KEY ("custodian_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_voids" ADD CONSTRAINT "charge_voids_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_voids" ADD CONSTRAINT "charge_voids_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissals" ADD CONSTRAINT "dismissals_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissals" ADD CONSTRAINT "dismissals_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissals" ADD CONSTRAINT "dismissals_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissals" ADD CONSTRAINT "dismissals_reinstated_by_users_id_fk" FOREIGN KEY ("reinstated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_evaluations" ADD CONSTRAINT "late_evaluations_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_collection_days" ADD CONSTRAINT "non_collection_days_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_source_charge_id_charges_id_fk" FOREIGN KEY ("source_charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_cash_close" ON "cash_closes" USING btree ("custodian_id","business_date");--> statement-breakpoint
CREATE INDEX "cash_custodian_date_idx" ON "cash_movements" USING btree ("custodian_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "one_daily_balance" ON "charges" USING btree ("operator_id","tricycle_id","business_date") WHERE "charges"."type" = 'daily_balance';--> statement-breakpoint
CREATE INDEX "charges_operator_idx" ON "charges" USING btree ("operator_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_dismissal" ON "dismissals" USING btree ("operator_id") WHERE "dismissals"."status" = 'flagged';--> statement-breakpoint
CREATE INDEX "allocations_charge_idx" ON "payment_allocations" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payments_operator_idx" ON "payments" USING btree ("operator_id","received_at");--> statement-breakpoint
CREATE INDEX "payments_date_idx" ON "payments" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "sms_status_idx" ON "sms_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "violations_operator_idx" ON "violations" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "violations_status_idx" ON "violations" USING btree ("status");