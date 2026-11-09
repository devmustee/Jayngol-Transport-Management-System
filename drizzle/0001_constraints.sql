CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- A tricycle can never be with two operators at once.
ALTER TABLE assignments ADD CONSTRAINT one_operator_per_tricycle
  EXCLUDE USING gist (
    tricycle_id WITH =,
    daterange(issued_on, returned_on, '[)') WITH &&
  );
--> statement-breakpoint
-- An operator can never hold two tricycles at once.
ALTER TABLE assignments ADD CONSTRAINT one_tricycle_per_operator
  EXCLUDE USING gist (
    operator_id WITH =,
    daterange(issued_on, returned_on, '[)') WITH &&
  );
--> statement-breakpoint
CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER balance_rates_append_only BEFORE UPDATE OR DELETE ON balance_rates
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER balance_rates_no_truncate BEFORE TRUNCATE ON balance_rates
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
