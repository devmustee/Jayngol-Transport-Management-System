CREATE TRIGGER photos_append_only BEFORE UPDATE OR DELETE ON photos
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER inspections_append_only BEFORE UPDATE OR DELETE ON inspections
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
