CREATE TABLE "tricycle_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tricycle_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tricycle_balances_positive" CHECK ("tricycle_balances"."amount_kobo" > 0)
);
--> statement-breakpoint
ALTER TABLE "tricycle_balances" ADD CONSTRAINT "tricycle_balances_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tricycle_balances" ADD CONSTRAINT "tricycle_balances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tricycle_balances_lookup_idx" ON "tricycle_balances" USING btree ("tricycle_id","effective_from");