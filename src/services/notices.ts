import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { smsOutbox } from "@/db/schema";
import { addDays } from "@/lib/clock";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";

/** Runs inside the nightly job, so one night can never queue these twice. */
export async function queueDayNotices(tx: Tx, date: string, now: Date) {
  const send = async (kind: string, rows: { phone: string; body: string }[]) => {
    if (rows.length === 0) return;
    await tx.insert(smsOutbox).values(rows.map((row) => ({ toPhone: row.phone, kind, body: row.body, createdAt: now })));
  };

  const dueToday = (await tx.execute(sql`
    SELECT o.phone, SUM(c.amount_kobo - COALESCE(p.paid, 0))::float8 AS owed
    FROM valid_charges c
    JOIN operators o ON o.id = c.operator_id AND o.status = 'active'
    LEFT JOIN LATERAL (
      SELECT SUM(e.amount_kobo) AS paid FROM effective_allocations e WHERE e.charge_id = c.id
    ) p ON TRUE
    WHERE c.type = 'daily_balance' AND c.due_on = ${date}::date
      AND c.amount_kobo > COALESCE(p.paid, 0)
    GROUP BY o.phone
  `)) as unknown as { phone: string; owed: number }[];
  await send(
    "balance_reminder",
    dueToday.map((row) => ({
      phone: row.phone,
      body: `Jayngol: ${formatNaira(row.owed)} of your balance is due today. Pay today to avoid a fine.`,
    })),
  );

  const fined = (await tx.execute(sql`
    SELECT o.phone, SUM(v.amount_kobo)::float8 AS total
    FROM violations v JOIN operators o ON o.id = v.operator_id
    WHERE v.rule_code = 'R1' AND v.status = 'confirmed' AND v.occurred_on = ${date}::date
    GROUP BY o.phone
  `)) as unknown as { phone: string; total: number }[];
  await send(
    "late_fine",
    fined.map((row) => ({
      phone: row.phone,
      body: `Jayngol: You have been fined ${formatNaira(row.total)} for a late balance.`,
    })),
  );

  const tomorrow = addDays(date, 1);
  const services = (await tx.execute(sql`
    SELECT o.phone, t.code_number AS code
    FROM work_orders w
    JOIN tricycles t ON t.id = w.tricycle_id
    JOIN assignments a ON a.tricycle_id = t.id AND a.returned_on IS NULL
    JOIN operators o ON o.id = a.operator_id
    WHERE w.type = 'service' AND w.status = 'scheduled' AND w.scheduled_for = ${tomorrow}::date
  `)) as unknown as { phone: string; code: string }[];
  await send(
    "service_reminder",
    services.map((row) => ({
      phone: row.phone,
      body: `Jayngol: ${row.code} is due for service on ${formatDate(tomorrow)}, between 8:00 and 10:00 am.`,
    })),
  );
}
