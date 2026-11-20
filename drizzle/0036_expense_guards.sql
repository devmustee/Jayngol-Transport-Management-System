ALTER TABLE "expense_advances" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_advances" ADD COLUMN "backdate_reason" text;--> statement-breakpoint
ALTER TABLE "expense_advances" ADD COLUMN "rejected_by" uuid;--> statement-breakpoint
ALTER TABLE "expense_advances" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expense_advances" ADD CONSTRAINT "expense_advances_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_advances" ADD CONSTRAINT "expense_advances_client_unique" UNIQUE("client_id");