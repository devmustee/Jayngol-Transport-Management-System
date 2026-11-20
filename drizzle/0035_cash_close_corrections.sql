CREATE TABLE "cash_close_corrections" (
	"close_id" uuid PRIMARY KEY NOT NULL,
	"counted_kobo" bigint NOT NULL,
	"reason" text NOT NULL,
	"corrected_by" uuid NOT NULL,
	"corrected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_close_corrections" ADD CONSTRAINT "cash_close_corrections_close_id_cash_closes_id_fk" FOREIGN KEY ("close_id") REFERENCES "public"."cash_closes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_corrections" ADD CONSTRAINT "cash_close_corrections_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER cash_close_corrections_append_only BEFORE UPDATE OR DELETE ON cash_close_corrections
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
