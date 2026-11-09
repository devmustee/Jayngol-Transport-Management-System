CREATE TYPE "public"."attendance_status" AS ENUM('present_with_tricycle', 'present_without_tricycle', 'absent', 'excused');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tricycle_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"inspected_by" uuid NOT NULL,
	"business_date" date NOT NULL,
	"washed" boolean NOT NULL,
	"sticker_intact" boolean NOT NULL,
	"note" text,
	"photo_id" uuid,
	"client_id" uuid NOT NULL,
	"inspected_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inspections_client_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "meeting_attendance" (
	"meeting_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"status" "attendance_status" NOT NULL,
	"reason" text,
	"tricycle_id" uuid,
	"tricycle_off_road" boolean DEFAULT false NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "meeting_attendance_meeting_id_operator_id_pk" PRIMARY KEY("meeting_id","operator_id")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sticker_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tricycle_id" uuid NOT NULL,
	"opened_on" date NOT NULL,
	"closed_on" date,
	"violation_id" uuid
);
--> statement-breakpoint
ALTER TABLE "violations" ADD COLUMN "photo_id" uuid;--> statement-breakpoint
ALTER TABLE "violations" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_inspected_by_users_id_fk" FOREIGN KEY ("inspected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_incidents" ADD CONSTRAINT "sticker_incidents_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_incidents" ADD CONSTRAINT "sticker_incidents_violation_id_violations_id_fk" FOREIGN KEY ("violation_id") REFERENCES "public"."violations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_inspection_per_day" ON "inspections" USING btree ("tricycle_id","business_date");--> statement-breakpoint
CREATE INDEX "inspections_date_idx" ON "inspections" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "inspections_operator_idx" ON "inspections" USING btree ("operator_id","business_date");--> statement-breakpoint
CREATE INDEX "meetings_scheduled_idx" ON "meetings" USING btree ("scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_sticker_incident" ON "sticker_incidents" USING btree ("tricycle_id") WHERE "sticker_incidents"."closed_on" IS NULL;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;