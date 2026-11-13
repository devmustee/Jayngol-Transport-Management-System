ALTER TABLE "expense_advances" ADD COLUMN "one_step" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Expenses already recorded in one step (since commit ba91530) are known by their audit entry.
UPDATE "expense_advances" SET "one_step" = true
WHERE "id"::text IN (SELECT "entity_id" FROM "audit_log" WHERE "action" = 'expense.record' AND "entity_type" = 'expense_advance');
