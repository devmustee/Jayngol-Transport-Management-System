-- A tricycle's balance history is append-only, like the charges it drives.
CREATE TRIGGER tricycle_balances_append_only BEFORE UPDATE OR DELETE ON tricycle_balances
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER tricycle_balances_no_truncate BEFORE TRUNCATE ON tricycle_balances
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- Every tricycle that has been issued takes the amounts it was charged, from
-- the dates they started. Its amount today is then exactly what it is charged
-- today (or, back in stock, what it was charged last). Tricycles never issued
-- get no row and show "Daily balance not set".
INSERT INTO tricycle_balances (tricycle_id, amount_kobo, effective_from, reason, created_by, created_at)
SELECT a.tricycle_id, r.amount_kobo, r.effective_from, 'Taken from the issue record', r.created_by, r.created_at
FROM balance_rates r
JOIN assignments a ON a.id = r.assignment_id
ORDER BY a.tricycle_id, r.effective_from, r.created_at;
