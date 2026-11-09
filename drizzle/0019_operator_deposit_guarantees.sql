CREATE SEQUENCE deposit_receipt_seq START 1001;
--> statement-breakpoint
CREATE TRIGGER operator_deposits_append_only BEFORE UPDATE OR DELETE ON operator_deposits
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER operator_deposit_reversals_append_only BEFORE UPDATE OR DELETE ON operator_deposit_reversals
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
