CREATE TRIGGER award_milestones_no_delete BEFORE DELETE ON award_milestones
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE FUNCTION award_milestone_void_only() RETURNS trigger AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL
    OR NEW.voided_at IS NULL
    OR NEW.void_reason IS NULL
    OR (to_jsonb(NEW) - 'voided_at' - 'void_reason') <> (to_jsonb(OLD) - 'voided_at' - 'void_reason') THEN
    RAISE EXCEPTION 'A milestone can only be voided, once, with a reason';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER award_milestones_void_only BEFORE UPDATE ON award_milestones
  FOR EACH ROW EXECUTE FUNCTION award_milestone_void_only();
