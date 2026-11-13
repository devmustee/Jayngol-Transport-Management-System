-- The Manager's own expenses need no approval (EXPENSES_NOT_PAID_BACK_PLAN.md
-- section 11). Records the Manager sent for the Assistant Manager's countersign
-- are approved as they stand, with no approver.
UPDATE "expense_advances" a
SET "status" = 'countersigned', "countersigned_at" = COALESCE(a."submitted_at", now())
FROM "users" u
WHERE u."id" = a."collected_by" AND u."role" = 'manager' AND a."status" = 'submitted';
