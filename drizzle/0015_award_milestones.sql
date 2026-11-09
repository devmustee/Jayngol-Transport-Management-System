CREATE TABLE "award_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"code" text NOT NULL,
	"reached_on" date NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text
);
--> statement-breakpoint
ALTER TABLE "operator_notices" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "award_milestones" ADD CONSTRAINT "award_milestones_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "award_milestones_once" ON "award_milestones" USING btree ("operator_id","code") WHERE "award_milestones"."voided_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_notices_once" ON "operator_notices" USING btree ("operator_id","dedupe_key") WHERE "operator_notices"."dedupe_key" IS NOT NULL;