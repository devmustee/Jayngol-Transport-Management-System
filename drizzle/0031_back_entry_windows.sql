CREATE TABLE "back_entry_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_date" date NOT NULL,
	"until_date" date NOT NULL,
	"stop_on" date NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "back_entry_dates" CHECK (from_date <= until_date AND until_date < stop_on)
);
--> statement-breakpoint
ALTER TABLE "back_entry_windows" ADD CONSTRAINT "back_entry_windows_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "back_entry_windows" ADD CONSTRAINT "back_entry_windows_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_back_entry" ON "back_entry_windows" USING btree ((closed_at IS NULL)) WHERE closed_at IS NULL;