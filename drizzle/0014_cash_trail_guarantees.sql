-- Payments made before references were required stay traceable and uniquely named.
INSERT INTO payment_references (payment_id, reference, released_at)
SELECT p.id, 'OLD-' || p.receipt_number, r.reversed_at
FROM payments p LEFT JOIN payment_reversals r ON r.payment_id = p.id
WHERE p.method <> 'cash';
--> statement-breakpoint
INSERT INTO cash_close_checks (close_id, note, checked_at)
SELECT id, 'Closed before second checks began', closed_at FROM cash_closes;
--> statement-breakpoint
CREATE TRIGGER cash_close_checks_append_only BEFORE UPDATE OR DELETE ON cash_close_checks
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER bank_reconciliations_append_only BEFORE UPDATE OR DELETE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
