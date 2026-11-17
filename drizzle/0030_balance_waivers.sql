CREATE TABLE "balance_waiver_lines" (
	"waiver_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	CONSTRAINT "balance_waiver_lines_waiver_id_charge_id_pk" PRIMARY KEY("waiver_id","charge_id"),
	CONSTRAINT "balance_waiver_line_positive" CHECK ("balance_waiver_lines"."amount_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "balance_waiver_reversals" (
	"waiver_id" uuid PRIMARY KEY NOT NULL,
	"reversed_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"reversed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text NOT NULL,
	"fine_waived" boolean NOT NULL,
	"fleet_day" date,
	"waived_by" uuid NOT NULL,
	"waived_at" timestamp with time zone NOT NULL,
	CONSTRAINT "balance_waiver_reason" CHECK ("balance_waivers"."reason" IN ('breakdown', 'illness', 'bereavement', 'accident', 'police', 'staff_mistake', 'no_balance_day', 'other'))
);
--> statement-breakpoint
ALTER TABLE "balance_waiver_lines" ADD CONSTRAINT "balance_waiver_lines_waiver_id_balance_waivers_id_fk" FOREIGN KEY ("waiver_id") REFERENCES "public"."balance_waivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_waiver_lines" ADD CONSTRAINT "balance_waiver_lines_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_waiver_reversals" ADD CONSTRAINT "balance_waiver_reversals_waiver_id_balance_waivers_id_fk" FOREIGN KEY ("waiver_id") REFERENCES "public"."balance_waivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_waiver_reversals" ADD CONSTRAINT "balance_waiver_reversals_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_waivers" ADD CONSTRAINT "balance_waivers_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_waivers" ADD CONSTRAINT "balance_waivers_waived_by_users_id_fk" FOREIGN KEY ("waived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_waiver_lines_charge_idx" ON "balance_waiver_lines" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "balance_waivers_operator_idx" ON "balance_waivers" USING btree ("operator_id","waived_at");--> statement-breakpoint
CREATE INDEX "balance_waivers_at_idx" ON "balance_waivers" USING btree ("waived_at");--> statement-breakpoint
CREATE TRIGGER balance_waivers_append_only BEFORE UPDATE OR DELETE ON "balance_waivers" FOR EACH ROW EXECUTE FUNCTION forbid_change();--> statement-breakpoint
CREATE TRIGGER balance_waiver_lines_append_only BEFORE UPDATE OR DELETE ON "balance_waiver_lines" FOR EACH ROW EXECUTE FUNCTION forbid_change();--> statement-breakpoint
CREATE TRIGGER balance_waiver_reversals_append_only BEFORE UPDATE OR DELETE ON "balance_waiver_reversals" FOR EACH ROW EXECUTE FUNCTION forbid_change();--> statement-breakpoint
-- Only daily balances can be waived.
CREATE FUNCTION waiver_line_is_balance() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM charges c WHERE c.id = NEW.charge_id AND c.type = 'daily_balance') THEN
    RAISE EXCEPTION 'Only a daily balance can be waived' USING ERRCODE = 'check_violation', CONSTRAINT = 'waiver_line_is_balance';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER balance_waiver_lines_balance_only BEFORE INSERT ON "balance_waiver_lines" FOR EACH ROW EXECUTE FUNCTION waiver_line_is_balance();--> statement-breakpoint
-- Each waived line that still counts, with when it was waived.
CREATE VIEW effective_waivers AS
  SELECT l.waiver_id, l.charge_id, l.amount_kobo, w.operator_id, w.waived_at
  FROM balance_waiver_lines l
  JOIN balance_waivers w ON w.id = l.waiver_id
  WHERE NOT EXISTS (SELECT 1 FROM balance_waiver_reversals r WHERE r.waiver_id = l.waiver_id);--> statement-breakpoint
-- Charges that still count, at what is still charged after waivers. A charge
-- waived down to nothing drops out, like a void.
CREATE OR REPLACE VIEW valid_charges AS
  SELECT c.id, c.type, c.operator_id, c.tricycle_id, c.assignment_id,
         (c.amount_kobo - COALESCE(w.waived, 0))::bigint AS amount_kobo,
         c.business_date, c.due_on, c.created_at
  FROM charges c
  LEFT JOIN LATERAL (
    SELECT SUM(e.amount_kobo) AS waived FROM effective_waivers e WHERE e.charge_id = c.id
  ) w ON true
  WHERE NOT EXISTS (SELECT 1 FROM charge_voids v WHERE v.charge_id = c.id)
    AND c.amount_kobo > COALESCE(w.waived, 0);--> statement-breakpoint
-- Daily balances as the award rules judge them: what was due by each day's
-- deadline. A waiver after the deadline does not make a late day on time,
-- and a day waived in full before its deadline counts as neither worked nor late.
CREATE VIEW award_balance_days AS
  SELECT c.id, c.type, c.operator_id, c.tricycle_id, c.assignment_id,
         (c.amount_kobo - COALESCE(w.waived, 0))::bigint AS amount_kobo,
         c.business_date, c.due_on, c.created_at
  FROM charges c
  LEFT JOIN LATERAL (
    SELECT SUM(e.amount_kobo) AS waived FROM effective_waivers e
    WHERE e.charge_id = c.id
      AND (c.due_on IS NULL OR e.waived_at < ((c.due_on + 1)::timestamp AT TIME ZONE 'Africa/Lagos'))
  ) w ON true
  WHERE c.type = 'daily_balance'
    AND NOT EXISTS (SELECT 1 FROM charge_voids v WHERE v.charge_id = c.id)
    AND c.amount_kobo > COALESCE(w.waived, 0);
