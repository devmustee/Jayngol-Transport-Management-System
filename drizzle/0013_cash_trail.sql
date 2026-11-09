CREATE TYPE "public"."bank_side" AS ENUM('bank', 'owner');--> statement-breakpoint
CREATE TYPE "public"."money_place" AS ENUM('cash', 'bank', 'owner');--> statement-breakpoint
CREATE TYPE "public"."money_transfer_status" AS ENUM('pending', 'done', 'rejected', 'voided');--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" date NOT NULL,
	"statement_kobo" bigint NOT NULL,
	"book_kobo" bigint NOT NULL,
	"unconfirmed_kobo" bigint NOT NULL,
	"explanation" text,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bank_reconciliations_month_unique" UNIQUE("month")
);
--> statement-breakpoint
CREATE TABLE "cash_close_checks" (
	"close_id" uuid PRIMARY KEY NOT NULL,
	"checked_by" uuid,
	"recounted_kobo" bigint,
	"note" text,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "money_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_place" "money_place" NOT NULL,
	"from_custodian" uuid,
	"to_place" "money_place" NOT NULL,
	"to_custodian" uuid,
	"amount_kobo" bigint NOT NULL,
	"reference" text,
	"photo_id" uuid,
	"note" text,
	"status" "money_transfer_status" DEFAULT 'done' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "transfer_amount_positive" CHECK (amount_kobo > 0),
	CONSTRAINT "transfer_cash_has_person" CHECK ((from_place = 'cash') = (from_custodian IS NOT NULL) AND (to_place = 'cash') = (to_custodian IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "operator_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_references" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"released_at" timestamp with time zone,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bank_movements" ADD COLUMN "account" "bank_side" DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_advances" ADD COLUMN "account" "bank_side" DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "account" "bank_side" DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_checks" ADD CONSTRAINT "cash_close_checks_close_id_cash_closes_id_fk" FOREIGN KEY ("close_id") REFERENCES "public"."cash_closes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_checks" ADD CONSTRAINT "cash_close_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_from_custodian_users_id_fk" FOREIGN KEY ("from_custodian") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_to_custodian_users_id_fk" FOREIGN KEY ("to_custodian") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_notices" ADD CONSTRAINT "operator_notices_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "money_transfers_status_idx" ON "money_transfers" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "operator_notices_idx" ON "operator_notices" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_live_reference" ON "payment_references" USING btree ("reference") WHERE released_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "one_opening_balance" ON "bank_movements" USING btree ("source_type") WHERE source_type = 'opening_balance';