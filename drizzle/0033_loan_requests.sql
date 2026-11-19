CREATE TYPE "public"."loan_request_status" AS ENUM('waiting', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TABLE "loan_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" "loan_request_status" DEFAULT 'waiting' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	CONSTRAINT "loan_request_amount_positive" CHECK (amount_kobo > 0),
	CONSTRAINT "loan_request_rejected_reason" CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "loan_requests" ADD CONSTRAINT "loan_requests_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_requests" ADD CONSTRAINT "loan_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_requests" ADD CONSTRAINT "loan_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_waiting_loan_request" ON "loan_requests" USING btree ("operator_id") WHERE status = 'waiting';--> statement-breakpoint
CREATE INDEX "loan_requests_status_idx" ON "loan_requests" USING btree ("status","requested_at");--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_request_id_loan_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."loan_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loan_from_request_once" UNIQUE("request_id");