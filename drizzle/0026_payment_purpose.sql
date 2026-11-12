CREATE TYPE "public"."payment_purpose" AS ENUM('day_balance', 'old_balance', 'fine', 'loan', 'general');--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "purpose" "payment_purpose" DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "for_date" date;--> statement-breakpoint
CREATE INDEX "payments_for_date_idx" ON "payments" USING btree ("operator_id","for_date");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_day_has_date" CHECK (("payments"."purpose" = 'day_balance') = ("payments"."for_date" IS NOT NULL));