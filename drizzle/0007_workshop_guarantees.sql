ALTER TABLE work_orders ADD CONSTRAINT work_order_shape CHECK (
  (type = 'service' AND cycle_date IS NOT NULL AND scheduled_for IS NOT NULL)
  OR (type = 'maintenance' AND fault IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE work_orders ADD CONSTRAINT labour_not_negative CHECK (labour_cost_kobo >= 0);
--> statement-breakpoint
ALTER TABLE off_road_periods ADD CONSTRAINT off_road_dates CHECK (ends_on IS NULL OR ends_on >= starts_on);
--> statement-breakpoint
ALTER TABLE off_road_periods ADD CONSTRAINT off_road_no_overlap
  EXCLUDE USING gist (tricycle_id WITH =, daterange(starts_on, ends_on, '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE stock_balances ADD CONSTRAINT stock_never_negative CHECK (quantity_milli >= 0 AND value_kobo >= 0);
--> statement-breakpoint
ALTER TABLE stock_items ADD CONSTRAINT reorder_not_negative CHECK (reorder_level_milli >= 0);
--> statement-breakpoint
ALTER TABLE stock_movements ADD CONSTRAINT movement_shape CHECK (
  quantity_milli <> 0
  AND (kind <> 'received' OR quantity_milli > 0)
  AND (kind <> 'returned' OR (quantity_milli > 0 AND reverses_id IS NOT NULL))
  AND (kind <> 'issued' OR (quantity_milli < 0 AND work_order_id IS NOT NULL AND tricycle_id IS NOT NULL))
  AND (kind <> 'adjusted' OR reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
WITH seeded AS (
  INSERT INTO stock_items (name, unit, serial_tracked, whole_only) VALUES
    ('Engine', 'engine', true, true),
    ('Gear oil', 'litre', false, false),
    ('Tyre', 'tyre', false, true)
  RETURNING id
)
INSERT INTO stock_balances (item_id) SELECT id FROM seeded;
