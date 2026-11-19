ALTER TYPE "public"."payment_method" ADD VALUE 'deposit';--> statement-breakpoint
CREATE TABLE "deposit_settlement_items" (
	"settlement_id" uuid NOT NULL,
	"deposit_id" uuid NOT NULL,
	CONSTRAINT "deposit_settlement_items_settlement_id_deposit_id_pk" PRIMARY KEY("settlement_id","deposit_id"),
	CONSTRAINT "deposit_settled_once" UNIQUE("deposit_id")
);
--> statement-breakpoint
CREATE TABLE "deposit_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"held_kobo" bigint NOT NULL,
	"cleared_kobo" bigint NOT NULL,
	"given_back_kobo" bigint NOT NULL,
	"kept_kobo" bigint NOT NULL,
	"kept_reason" text,
	"payment_id" uuid,
	"custodian_id" uuid,
	"account" "bank_side",
	"reference" text,
	"settled_by" uuid NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"undone_by" uuid,
	"undone_at" timestamp with time zone,
	CONSTRAINT "deposit_settlement_adds_up" CHECK (held_kobo = cleared_kobo + given_back_kobo + kept_kobo),
	CONSTRAINT "deposit_settlement_amounts" CHECK (held_kobo > 0 AND cleared_kobo >= 0 AND given_back_kobo >= 0 AND kept_kobo >= 0),
	CONSTRAINT "deposit_settlement_kept_reason" CHECK (kept_kobo = 0 OR kept_reason IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "deposit_settlement_items" ADD CONSTRAINT "deposit_settlement_items_settlement_id_deposit_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."deposit_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_settlement_items" ADD CONSTRAINT "deposit_settlement_items_deposit_id_operator_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."operator_deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_settlements" ADD CONSTRAINT "deposit_settlements_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_settlements" ADD CONSTRAINT "deposit_settlements_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_settlements" ADD CONSTRAINT "deposit_settlements_custodian_id_users_id_fk" FOREIGN KEY ("custodian_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_settlements" ADD CONSTRAINT "deposit_settlements_settled_by_users_id_fk" FOREIGN KEY ("settled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_settlements" ADD CONSTRAINT "deposit_settlements_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposit_settlements_operator_idx" ON "deposit_settlements" USING btree ("operator_id","settled_at");