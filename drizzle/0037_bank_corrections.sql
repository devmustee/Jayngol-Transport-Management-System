CREATE TABLE "bank_opening_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"as_of" date NOT NULL,
	"reason" text NOT NULL,
	"corrected_by" uuid NOT NULL,
	"corrected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliation_corrections" (
	"reconciliation_id" uuid PRIMARY KEY NOT NULL,
	"statement_kobo" bigint NOT NULL,
	"explanation" text,
	"reason" text NOT NULL,
	"corrected_by" uuid NOT NULL,
	"corrected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_opening_corrections" ADD CONSTRAINT "bank_opening_corrections_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_corrections" ADD CONSTRAINT "bank_reconciliation_corrections_reconciliation_id_bank_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."bank_reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_corrections" ADD CONSTRAINT "bank_reconciliation_corrections_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER bank_reconciliation_corrections_append_only BEFORE UPDATE OR DELETE ON bank_reconciliation_corrections
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER bank_opening_corrections_append_only BEFORE UPDATE OR DELETE ON bank_opening_corrections
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
