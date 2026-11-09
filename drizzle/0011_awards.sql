CREATE TYPE "public"."award_type" AS ENUM('consistency', 'clean_vehicle', 'law_abiding');--> statement-breakpoint
CREATE TYPE "public"."award_candidate_status" AS ENUM('proposed', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "award_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "award_type" NOT NULL,
	"operator_id" uuid NOT NULL,
	"run_on" date NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"status" "award_candidate_status" DEFAULT 'proposed' NOT NULL,
	"evidence" jsonb NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "one_candidate_per_run" UNIQUE("type","operator_id","run_on")
);
--> statement-breakpoint
CREATE TABLE "awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"given" text NOT NULL,
	"cost_kobo" bigint NOT NULL,
	"given_on" date NOT NULL,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "awards_candidate_id_unique" UNIQUE("candidate_id"),
	CONSTRAINT "award_cost_positive" CHECK (cost_kobo > 0)
);
--> statement-breakpoint
ALTER TABLE "award_candidates" ADD CONSTRAINT "award_candidates_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "award_candidates" ADD CONSTRAINT "award_candidates_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_candidate_id_award_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."award_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_pending_candidate" ON "award_candidates" USING btree ("type","operator_id") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX "award_candidates_status_idx" ON "award_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "awards_operator_idx" ON "awards" USING btree ("operator_id");