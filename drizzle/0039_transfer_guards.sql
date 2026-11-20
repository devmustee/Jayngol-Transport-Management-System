ALTER TABLE "payment_references" DROP CONSTRAINT "reference_has_one_owner";--> statement-breakpoint
ALTER TABLE "money_transfers" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_references" ADD COLUMN "transfer_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_transfer_id_money_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."money_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_client_unique" UNIQUE("client_id");--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_transfer_id_unique" UNIQUE("transfer_id");--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "reference_has_one_owner" CHECK (num_nonnulls(payment_id, deposit_id, transfer_id) = 1);