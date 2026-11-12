-- What someone was told never changes. Old notifications may be removed by a
-- clean-up job later (Phase 5), so only UPDATE is refused here.
CREATE TRIGGER notifications_fixed BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- A recipient row may only be marked read or acknowledged, once.
CREATE FUNCTION notification_recipient_marks_only() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.notification_id IS DISTINCT FROM OLD.notification_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.operator_id IS DISTINCT FROM OLD.operator_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at)
     OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at) THEN
    RAISE EXCEPTION 'notification_recipients can only be marked read or acknowledged' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER notification_recipients_marks_only BEFORE UPDATE ON notification_recipients
  FOR EACH ROW EXECUTE FUNCTION notification_recipient_marks_only();
--> statement-breakpoint
-- Every existing operator notice moves across with its id, wording, time and
-- read state. Wording and severity follow src/lib/notification-catalogue.ts.
INSERT INTO notifications (id, kind, severity, title, body, link, dedupe_key, created_at)
  SELECT n.id, n.kind,
         (CASE WHEN n.kind IN ('offence', 'meeting_notice', 'balance_reminder', 'late_fine', 'service_reminder')
               THEN 'action' ELSE 'info' END)::notification_severity,
         CASE n.kind
           WHEN 'receipt' THEN 'Payment received'
           WHEN 'offence' THEN 'Offence recorded'
           WHEN 'meeting_notice' THEN 'Meeting'
           WHEN 'award' THEN 'Award'
           WHEN 'milestone' THEN 'Milestone reached'
           WHEN 'run_ended' THEN 'Your run has ended'
           WHEN 'award_near' THEN 'Close to an award'
           WHEN 'balance_reminder' THEN 'Balance due today'
           WHEN 'late_fine' THEN 'Late balance fine'
           WHEN 'service_reminder' THEN 'Service tomorrow'
           ELSE 'Notice'
         END,
         n.body, '/me',
         CASE WHEN n.dedupe_key IS NOT NULL THEN 'op:' || n.operator_id || ':' || n.dedupe_key END,
         n.created_at
  FROM operator_notices n;
--> statement-breakpoint
INSERT INTO notification_recipients (notification_id, operator_id, created_at, read_at)
  SELECT n.id, n.operator_id, n.created_at, n.read_at FROM operator_notices n;
