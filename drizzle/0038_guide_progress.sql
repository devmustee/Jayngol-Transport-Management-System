CREATE TABLE "guide_progress" (
	"user_id" uuid NOT NULL,
	"tour_id" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guide_progress_user_id_tour_id_pk" PRIMARY KEY("user_id","tour_id"),
	CONSTRAINT "guide_progress_status" CHECK ("guide_progress"."status" IN ('done', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "guide_progress" ADD CONSTRAINT "guide_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;