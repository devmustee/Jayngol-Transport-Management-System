CREATE TYPE "public"."notification_severity" AS ENUM('info', 'action', 'critical');--> statement-breakpoint
CREATE TABLE "notification_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"user_id" uuid,
	"operator_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "recipient_is_one_person" CHECK (num_nonnulls(user_id, operator_id) = 1)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" "notification_severity" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"entity_type" text,
	"entity_id" text,
	"dedupe_key" text,
	"requires_ack" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notification_link_inside_app" CHECK (link IS NULL OR link LIKE '/%')
);
--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_notice_per_user" ON "notification_recipients" USING btree ("notification_id","user_id") WHERE "notification_recipients"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "one_notice_per_operator" ON "notification_recipients" USING btree ("notification_id","operator_id") WHERE "notification_recipients"."operator_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_inbox_idx" ON "notification_recipients" USING btree ("user_id","created_at") WHERE "notification_recipients"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "operator_inbox_idx" ON "notification_recipients" USING btree ("operator_id","created_at") WHERE "notification_recipients"."operator_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_unread_idx" ON "notification_recipients" USING btree ("user_id") WHERE "notification_recipients"."user_id" IS NOT NULL AND "notification_recipients"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "operator_unread_idx" ON "notification_recipients" USING btree ("operator_id") WHERE "notification_recipients"."operator_id" IS NOT NULL AND "notification_recipients"."read_at" IS NULL;