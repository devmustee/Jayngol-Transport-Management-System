import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Executor } from "@/db";
import * as schema from "@/db/schema";
import { CATALOGUE, isNotificationKind } from "@/lib/notification-catalogue";

/**
 * Run once on production straight after the notifications release is live.
 * Migration 0022 copied every operator notice that existed when it ran. Until
 * the new code is deployed, the old code keeps writing to operator_notices, so
 * this copies anything written in that gap, and any notice marked read there.
 * Safe to run again: each notice keeps its id, so nothing is copied twice.
 */
export async function copyOldNotices(exec: Executor) {
  const missing = (await exec.execute(sql`
    SELECT o.id, o.operator_id, o.kind, o.body, o.dedupe_key, o.created_at, o.read_at
    FROM operator_notices o
    WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.id = o.id)
    ORDER BY o.created_at
  `)) as unknown as {
    id: string;
    operator_id: string;
    kind: string;
    body: string;
    dedupe_key: string | null;
    created_at: Date;
    read_at: Date | null;
  }[];

  let copied = 0;
  for (const row of missing) {
    const entry = isNotificationKind(row.kind) ? CATALOGUE[row.kind] : null;
    const key = row.dedupe_key ? `op:${row.operator_id}:${row.dedupe_key}` : null;
    // A once-only notice the new code already posted is not posted again.
    const saved = (await exec.execute(sql`
      INSERT INTO notifications (id, kind, severity, title, body, link, dedupe_key, created_at)
      VALUES (${row.id}, ${row.kind}, ${entry?.severity ?? "info"}, ${entry?.title ?? "Notice"}, ${row.body}, '/me', ${key}, ${new Date(row.created_at).toISOString()})
      ON CONFLICT DO NOTHING
      RETURNING id
    `)) as unknown as { id: string }[];
    if (saved.length === 0) continue;
    await exec.execute(sql`
      INSERT INTO notification_recipients (notification_id, operator_id, created_at, read_at)
      VALUES (${row.id}, ${row.operator_id}, ${new Date(row.created_at).toISOString()}, ${row.read_at ? new Date(row.read_at).toISOString() : null})
    `);
    copied++;
  }

  // Notices an operator read on the old portal before the new code went live.
  const read = (await exec.execute(sql`
    UPDATE notification_recipients r SET read_at = o.read_at
    FROM operator_notices o
    WHERE r.notification_id = o.id AND r.operator_id = o.operator_id
      AND r.read_at IS NULL AND o.read_at IS NOT NULL
    RETURNING r.id
  `)) as unknown as { id: string }[];

  return { copied, markedRead: read.length };
}

if (process.argv[1]?.endsWith("copy-old-notices.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 1, onnotice: () => {} });
  copyOldNotices(drizzle(client, { schema }))
    .then(({ copied, markedRead }) => console.log(`Copied ${copied} notices, marked ${markedRead} as read.`))
    .finally(() => client.end());
}
