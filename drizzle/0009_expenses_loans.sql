CREATE TYPE "public"."expense_advance_status" AS ENUM('open', 'submitted', 'countersigned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('store_purchase', 'workshop_labour', 'transport', 'office', 'salaries', 'other');--> statement-breakpoint
CREATE TYPE "public"."expense_line_kind" AS ENUM('spent', 'change');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('active', 'cleared', 'cancelled');--> statement-breakpoint
CREATE TABLE "bank_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"business_date" date NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"status" "expense_advance_status" DEFAULT 'open' NOT NULL,
	"custodian_id" uuid,
	"collected_on" date NOT NULL,
	"collected_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"countersigned_by" uuid,
	"countersigned_at" timestamp with time zone,
	"return_note" text,
	"cancel_reason" text,
	CONSTRAINT "advance_amount_positive" CHECK (amount_kobo > 0),
	CONSTRAINT "advance_two_people" CHECK (countersigned_by IS NULL OR countersigned_by <> collected_by)
);
--> statement-breakpoint
CREATE TABLE "expense_line_voids" (
	"line_id" uuid PRIMARY KEY NOT NULL,
	"voided_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"voided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advance_id" uuid NOT NULL,
	"kind" "expense_line_kind" NOT NULL,
	"category" "expense_category",
	"description" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"spent_on" date NOT NULL,
	"photo_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "expense_line_amount_positive" CHECK (amount_kobo > 0),
	CONSTRAINT "expense_spent_has_category" CHECK (kind <> 'spent' OR category IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"principal_kobo" bigint NOT NULL,
	"status" "loan_status" DEFAULT 'active' NOT NULL,
	"custodian_id" uuid,
	"note" text,
	"disbursed_on" date NOT NULL,
	"approved_by" uuid NOT NULL,
	"cancel_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "loans_charge_id_unique" UNIQUE("charge_id"),
	CONSTRAINT "loan_principal_positive" CHECK (principal_kobo > 0)
);
--> statement-breakpoint
ALTER TABLE "expense_advances" ADD CONSTRAINT "expense_advances_custodian_id_users_id_fk" FOREIGN KEY ("custodian_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_advances" ADD CONSTRAINT "expense_advances_collected_by_users_id_fk" FOREIGN KEY ("collected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_advances" ADD CONSTRAINT "expense_advances_countersigned_by_users_id_fk" FOREIGN KEY ("countersigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_line_voids" ADD CONSTRAINT "expense_line_voids_line_id_expense_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."expense_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_line_voids" ADD CONSTRAINT "expense_line_voids_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_advance_id_expense_advances_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."expense_advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_custodian_id_users_id_fk" FOREIGN KEY ("custodian_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_date_idx" ON "bank_movements" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "advances_status_idx" ON "expense_advances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "expense_lines_advance_idx" ON "expense_lines" USING btree ("advance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_loan" ON "loans" USING btree ("operator_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "loans_operator_idx" ON "loans" USING btree ("operator_id");