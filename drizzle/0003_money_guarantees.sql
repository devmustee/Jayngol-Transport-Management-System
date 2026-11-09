CREATE SEQUENCE receipt_seq START 1001;
--> statement-breakpoint
CREATE TRIGGER charges_append_only BEFORE UPDATE OR DELETE ON charges
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER charge_voids_append_only BEFORE UPDATE OR DELETE ON charge_voids
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER payment_reversals_append_only BEFORE UPDATE OR DELETE ON payment_reversals
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER cash_closes_append_only BEFORE UPDATE OR DELETE ON cash_closes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- Charges that still count: anything not voided.
CREATE VIEW valid_charges AS
  SELECT c.* FROM charges c
  WHERE NOT EXISTS (SELECT 1 FROM charge_voids v WHERE v.charge_id = c.id);
--> statement-breakpoint
-- Money that still counts: allocations from payments that were not reversed.
CREATE VIEW effective_allocations AS
  SELECT a.payment_id, a.charge_id, a.amount_kobo, p.received_at, p.operator_id
  FROM payment_allocations a
  JOIN payments p ON p.id = a.payment_id
  WHERE NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id);
--> statement-breakpoint
INSERT INTO rules (code, effective_from, name, amount_kobo) VALUES
  ('R1', '2020-01-01', 'Balance not paid within 2 days', 300000),
  ('R2', '2020-01-01', 'Tricycle not washed and polished', 300000),
  ('R3', '2020-01-01', 'Late for service', 300000),
  ('R4', '2020-01-01', 'Company sticker removed', 300000),
  ('R5', '2020-01-01', 'At general meeting without tricycle', 300000),
  ('R6', '2020-01-01', 'Absent from general meeting', 600000),
  ('R7', '2020-01-01', 'Working after 10:00 pm', 300000),
  ('R8', '2020-01-01', 'Came to pay balance without tricycle', 300000);
