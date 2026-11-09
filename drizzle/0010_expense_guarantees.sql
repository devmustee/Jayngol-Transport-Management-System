CREATE TRIGGER expense_lines_append_only BEFORE UPDATE OR DELETE ON expense_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER expense_line_voids_append_only BEFORE UPDATE OR DELETE ON expense_line_voids
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER bank_movements_append_only BEFORE UPDATE OR DELETE ON bank_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- Transfers and POS already received, so the cash book starts complete.
INSERT INTO bank_movements (amount_kobo, business_date, source_type, source_id, at)
  SELECT amount_kobo, business_date, 'payment', id::text, received_at
  FROM payments WHERE method <> 'cash';
--> statement-breakpoint
INSERT INTO bank_movements (amount_kobo, business_date, source_type, source_id, at)
  SELECT -p.amount_kobo, (r.reversed_at AT TIME ZONE 'Africa/Lagos')::date, 'payment_reversal', p.id::text, r.reversed_at
  FROM payment_reversals r JOIN payments p ON p.id = r.payment_id WHERE p.method <> 'cash';
