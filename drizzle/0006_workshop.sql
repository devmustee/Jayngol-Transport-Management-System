CREATE TYPE "public"."stock_movement_kind" AS ENUM('received', 'issued', 'returned', 'adjusted');--> statement-breakpoint
CREATE TYPE "public"."stock_unit_status" AS ENUM('in_store', 'fitted', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."work_order_status" AS ENUM('scheduled', 'checked_in', 'completed', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_order_type" AS ENUM('service', 'maintenance');--> statement-breakpoint
CREATE TABLE "off_road_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tricycle_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"quantity_milli" bigint DEFAULT 0 NOT NULL,
	"value_kobo" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"serial_tracked" boolean DEFAULT false NOT NULL,
	"whole_only" boolean DEFAULT true NOT NULL,
	"reorder_level_milli" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_items_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"cost_kobo" bigint NOT NULL,
	"work_order_id" uuid,
	"tricycle_id" uuid,
	"stock_unit_id" uuid,
	"reverses_id" uuid,
	"reason" text,
	"performed_by" uuid NOT NULL,
	"business_date" date NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stock_movement_reversed_once" UNIQUE("reverses_id")
);
--> statement-breakpoint
CREATE TABLE "stock_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"status" "stock_unit_status" DEFAULT 'in_store' NOT NULL,
	"cost_kobo" bigint NOT NULL,
	"work_order_id" uuid,
	"tricycle_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stock_units_serial_unique" UNIQUE("serial")
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "work_order_type" NOT NULL,
	"tricycle_id" uuid NOT NULL,
	"status" "work_order_status" NOT NULL,
	"cycle_date" date,
	"scheduled_for" date,
	"fault" text,
	"findings" text,
	"labour_cost_kobo" bigint DEFAULT 0 NOT NULL,
	"cancel_reason" text,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" uuid,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "one_service_per_cycle" UNIQUE("tricycle_id","cycle_date")
);
--> statement-breakpoint
ALTER TABLE "off_road_periods" ADD CONSTRAINT "off_road_periods_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "off_road_periods" ADD CONSTRAINT "off_road_periods_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stock_unit_id_stock_units_id_fk" FOREIGN KEY ("stock_unit_id") REFERENCES "public"."stock_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_units" ADD CONSTRAINT "stock_units_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_units" ADD CONSTRAINT "stock_units_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_units" ADD CONSTRAINT "stock_units_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_tricycle_id_tricycles_id_fk" FOREIGN KEY ("tricycle_id") REFERENCES "public"."tricycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_off_road" ON "off_road_periods" USING btree ("tricycle_id") WHERE "off_road_periods"."ends_on" IS NULL;--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "stock_movements" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_work_order_idx" ON "stock_movements" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "stock_movements_tricycle_idx" ON "stock_movements" USING btree ("tricycle_id");--> statement-breakpoint
CREATE INDEX "stock_units_item_idx" ON "stock_units" USING btree ("item_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_repair" ON "work_orders" USING btree ("tricycle_id") WHERE "work_orders"."type" = 'maintenance' AND "work_orders"."status" = 'checked_in';--> statement-breakpoint
CREATE INDEX "work_orders_status_idx" ON "work_orders" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "work_orders_tricycle_idx" ON "work_orders" USING btree ("tricycle_id");