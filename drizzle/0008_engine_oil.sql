UPDATE stock_items SET name = 'Engine oil', unit = 'litre', serial_tracked = false, whole_only = false WHERE name = 'Engine';
--> statement-breakpoint
ALTER TABLE "stock_units" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "stock_units" CASCADE;--> statement-breakpoint
ALTER TABLE "stock_items" DROP COLUMN "serial_tracked";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP COLUMN "stock_unit_id";--> statement-breakpoint
DROP TYPE "public"."stock_unit_status";