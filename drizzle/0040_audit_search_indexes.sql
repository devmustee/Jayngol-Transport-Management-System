CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_user_id","id");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action","id");