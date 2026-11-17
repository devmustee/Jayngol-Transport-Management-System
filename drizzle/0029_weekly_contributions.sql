ALTER TYPE "public"."charge_type" ADD VALUE 'contribution';--> statement-breakpoint
ALTER TYPE "public"."payment_purpose" ADD VALUE 'contribution';--> statement-breakpoint
CREATE TABLE "contribution_rates" (
	"effective_from" date PRIMARY KEY NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_rate_positive" CHECK ("contribution_rates"."amount_kobo" > 0),
	CONSTRAINT "contribution_rate_on_sunday" CHECK (extract(isodow from "contribution_rates"."effective_from") = 7)
);
--> statement-breakpoint
CREATE TABLE "contribution_weeks" (
	"charge_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"week_ending" date NOT NULL,
	CONSTRAINT "one_contribution_per_week" UNIQUE("operator_id","week_ending"),
	CONSTRAINT "contribution_week_on_sunday" CHECK (extract(isodow from "contribution_weeks"."week_ending") = 7)
);
--> statement-breakpoint
ALTER TABLE "contribution_rates" ADD CONSTRAINT "contribution_rates_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_weeks" ADD CONSTRAINT "contribution_weeks_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_weeks" ADD CONSTRAINT "contribution_weeks_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contribution_weeks_week_idx" ON "contribution_weeks" USING btree ("week_ending");--> statement-breakpoint
CREATE TRIGGER contribution_rates_append_only BEFORE UPDATE OR DELETE ON "contribution_rates" FOR EACH ROW EXECUTE FUNCTION forbid_change();--> statement-breakpoint
CREATE TRIGGER contribution_weeks_append_only BEFORE UPDATE OR DELETE ON "contribution_weeks" FOR EACH ROW EXECUTE FUNCTION forbid_change();
