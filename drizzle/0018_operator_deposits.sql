CREATE TABLE "operator_deposit_reversals" (
	"deposit_id" uuid PRIMARY KEY NOT NULL,
	"reversed_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"reversed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"receipt_number" text NOT NULL,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	CONSTRAINT "operator_deposits_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "operator_deposits_receipt_number_unique" UNIQUE("receipt_number"),
	CONSTRAINT "operator_deposit_positive" CHECK (amount_kobo > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_references" DROP CONSTRAINT "payment_references_pkey";--> statement-breakpoint
ALTER TABLE "payment_references" ALTER COLUMN "payment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_references" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_references" ADD COLUMN "deposit_id" uuid;--> statement-breakpoint
ALTER TABLE "operator_deposit_reversals" ADD CONSTRAINT "operator_deposit_reversals_deposit_id_operator_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."operator_deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deposit_reversals" ADD CONSTRAINT "operator_deposit_reversals_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deposits" ADD CONSTRAINT "operator_deposits_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deposits" ADD CONSTRAINT "operator_deposits_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_deposits_operator_idx" ON "operator_deposits" USING btree ("operator_id","received_at");--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_deposit_id_operator_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."operator_deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_payment_id_unique" UNIQUE("payment_id");--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_deposit_id_unique" UNIQUE("deposit_id");--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "reference_has_one_owner" CHECK (num_nonnulls(payment_id, deposit_id) = 1);