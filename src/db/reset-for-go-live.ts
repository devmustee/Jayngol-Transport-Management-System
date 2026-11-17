/**
 * Clears every record before live use (PRODUCTION_RESET_PLAN.md). Keeps the
 * Manager, Assistant Manager and Owner logins, operators, tricycles with their
 * daily balances, the rules and fine amounts, and the store item list at zero.
 *
 *   npm run db:reset-go-live                      shows what would happen, changes nothing
 *   npm run db:reset-go-live -- --confirm <db>    does it, in one transaction
 *
 * Take a backup first: the backup is the only way back.
 */
import { sql } from "drizzle-orm";
import { db, pgClient, type Tx } from "./index";
import { recordAudit } from "../services/audit";

/** Never these: tests and day-to-day development need their data. */
const REFUSED = ["jayngol_test", "jayngol_dev"];

/** Logins that stay. Supervisors and operator portal logins go (decisions 1 to 3). */
const KEPT_ROLES = ["manager", "assistant_manager", "owner"] as const;

/** Tables that stay, some of them tidied. */
const KEPT = ["users", "operators", "tricycles", "tricycle_balances", "rules", "stock_items", "stock_balances"];

/** Tables emptied completely. */
const CLEARED = [
  // Ledger and money
  "charges", "charge_voids", "payments", "payment_allocations", "payment_reversals", "payment_references",
  "late_evaluations", "balance_waivers", "balance_waiver_lines", "balance_waiver_reversals", "loans",
  "operator_deposits", "operator_deposit_reversals", "contribution_rates", "contribution_weeks",
  // Cash and bank
  "cash_movements", "cash_closes", "cash_close_checks", "money_transfers", "bank_movements",
  "bank_reconciliations", "expense_advances", "expense_lines", "expense_line_voids",
  // Who holds what
  "assignments", "balance_rates", "off_road_periods",
  // Discipline and awards
  "violations", "sticker_incidents", "dismissals", "meetings", "meeting_attendance",
  "award_candidates", "awards", "award_milestones",
  // Workshop and store
  "work_orders", "inspections", "stock_movements",
  // Messages and system
  "notifications", "notification_recipients", "operator_notices", "sms_outbox", "photos",
  "non_collection_days", "job_runs", "sessions", "login_failures", "audit_log",
];

/** These refuse TRUNCATE outright, so their guard is switched off for the reset only. */
const TRUNCATE_GUARDS: [string, string][] = [
  ["audit_log", "audit_log_no_truncate"],
  ["balance_rates", "balance_rates_no_truncate"],
];

const SEQUENCES = ["receipt_seq", "deposit_receipt_seq"];

type Counts = Record<string, number>;

const rows = <T>(result: unknown) => result as T[];

async function countAll(exec: Tx | typeof db, tables: string[]): Promise<Counts> {
  const counts: Counts = {};
  for (const table of tables) {
    const [row] = rows<{ n: number }>(await exec.execute(sql`SELECT COUNT(*)::int AS n FROM ${sql.identifier(table)}`));
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

async function kept(exec: Tx | typeof db) {
  const [row] = rows<{ logins: number; removed: number; operators: number; tricycles: number; items: number }>(
    await exec.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE role::text IN ${sql.raw(`('${KEPT_ROLES.join("','")}')`)}) AS logins,
        (SELECT COUNT(*)::int FROM users WHERE role::text NOT IN ${sql.raw(`('${KEPT_ROLES.join("','")}')`)}) AS removed,
        (SELECT COUNT(*)::int FROM operators) AS operators,
        (SELECT COUNT(*)::int FROM tricycles) AS tricycles,
        (SELECT COUNT(*)::int FROM stock_items) AS items
    `),
  );
  return row!;
}

/** Every table must be named above, so a table added later is never kept or wiped by accident. */
async function checkEveryTableIsListed() {
  const all = rows<{ name: string }>(
    await db.execute(sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`),
  ).map((row) => row.name);
  const unknown = all.filter((name) => !KEPT.includes(name) && !CLEARED.includes(name));
  const missing = [...KEPT, ...CLEARED].filter((name) => !all.includes(name));
  if (unknown.length > 0) throw new Error(`Not in the keep or clear list, so nothing was done: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`Listed but not in this database: ${missing.join(", ")}`);
}

/** The removed logins must only be referenced from tables that are cleared or tidied. */
async function checkRemovedUsersAreFree(tx: Tx) {
  const [row] = rows<{ n: number }>(
    await tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM tricycle_balances b JOIN users u ON u.id = b.created_by
      WHERE u.role::text NOT IN ${sql.raw(`('${KEPT_ROLES.join("','")}')`)}
    `),
  );
  if ((row?.n ?? 0) > 0) throw new Error("A tricycle's daily balance was set by a login being removed. Nothing was done.");
}

async function reset(tx: Tx, before: Counts) {
  const keptBefore = await kept(tx);
  await checkRemovedUsersAreFree(tx);

  for (const [table, trigger] of TRUNCATE_GUARDS) {
    await tx.execute(sql`ALTER TABLE ${sql.identifier(table)} DISABLE TRIGGER ${sql.identifier(trigger)}`);
  }
  await tx.execute(sql.raw(`TRUNCATE ${CLEARED.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY`));
  for (const [table, trigger] of TRUNCATE_GUARDS) {
    await tx.execute(sql`ALTER TABLE ${sql.identifier(table)} ENABLE TRIGGER ${sql.identifier(trigger)}`);
  }

  await tx.execute(sql`UPDATE operators SET user_id = NULL WHERE user_id IS NOT NULL`);
  await tx.execute(sql.raw(`DELETE FROM users WHERE role::text NOT IN ('${KEPT_ROLES.join("','")}')`));
  await tx.execute(sql`UPDATE users SET failed_attempts = 0, locked_until = NULL`);
  await tx.execute(sql`UPDATE tricycles SET status = 'in_stock' WHERE status <> 'retired'`);
  await tx.execute(sql`UPDATE stock_balances SET quantity_milli = 0, value_kobo = 0`);
  for (const sequence of SEQUENCES) await tx.execute(sql.raw(`ALTER SEQUENCE "${sequence}" RESTART WITH 1`));

  await recordAudit(tx, null, new Date(), {
    action: "system.reset",
    entityType: "system",
    entityId: "go-live",
    before: { rows: before, logins: keptBefore.logins + keptBefore.removed },
    after: { logins: keptBefore.logins, operators: keptBefore.operators, tricycles: keptBefore.tricycles },
    reason: "System reset for go-live",
  });

  // Checks. Any failure rolls back everything above.
  const after = await countAll(tx, CLEARED);
  const left = Object.entries(after).filter(([table, n]) => (table === "audit_log" ? n !== 1 : n !== 0));
  if (left.length > 0) throw new Error(`Rows left behind: ${left.map(([t, n]) => `${t} ${n}`).join(", ")}`);
  const keptAfter = await kept(tx);
  if (
    keptAfter.logins !== keptBefore.logins ||
    keptAfter.removed !== 0 ||
    keptAfter.operators !== keptBefore.operators ||
    keptAfter.tricycles !== keptBefore.tricycles ||
    keptAfter.items !== keptBefore.items
  ) {
    throw new Error(`Kept records changed: ${JSON.stringify({ before: keptBefore, after: keptAfter })}`);
  }
  const [state] = rows<{ busy: number; linked: number; stock: number; manager: number }>(
    await tx.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM tricycles WHERE status NOT IN ('in_stock', 'retired')) AS busy,
        (SELECT COUNT(*)::int FROM operators WHERE user_id IS NOT NULL) AS linked,
        (SELECT COUNT(*)::int FROM stock_balances WHERE quantity_milli <> 0 OR value_kobo <> 0) AS stock,
        (SELECT COUNT(*)::int FROM users WHERE role = 'manager' AND status = 'active') AS manager
    `),
  );
  if (state!.busy || state!.linked || state!.stock) throw new Error(`Tidying failed: ${JSON.stringify(state)}`);
  if (state!.manager === 0) throw new Error("No active Manager login would be left. Nothing was done.");
  return keptAfter;
}

async function main() {
  const args = process.argv.slice(2);
  const confirmAt = args.indexOf("--confirm");
  const confirmed = confirmAt >= 0 ? args[confirmAt + 1] : undefined;

  const [{ name } = { name: "" }] = rows<{ name: string }>(await db.execute(sql`SELECT current_database() AS name`));
  if (REFUSED.includes(name)) throw new Error(`Refusing to reset ${name}.`);
  await checkEveryTableIsListed();

  const before = await countAll(db, CLEARED);
  const keep = await kept(db);
  console.log(`Database: ${name}\n`);
  console.log("Kept:");
  console.log(`  logins (Manager, Assistant Manager, Owner)  ${keep.logins}`);
  console.log(`  operators                                   ${keep.operators}`);
  console.log(`  tricycles, with their daily balances        ${keep.tricycles}`);
  console.log(`  store items, at zero stock                  ${keep.items}`);
  console.log(`  rules and fine amounts`);
  console.log(`\nRemoved logins (Supervisors, operator portal): ${keep.removed}`);
  console.log("\nRows cleared:");
  for (const [table, n] of Object.entries(before)) if (n > 0) console.log(`  ${table.padEnd(28)} ${n}`);
  console.log(`  (${Object.values(before).filter((n) => n === 0).length} tables already empty)`);

  if (confirmed === undefined) {
    console.log(`\nNothing was changed. To reset, take a backup, then run again with --confirm ${name}`);
    return;
  }
  if (confirmed !== name) throw new Error(`--confirm ${confirmed} does not match this database (${name}). Nothing was done.`);

  const result = await db.transaction((tx) => reset(tx, before));
  console.log(`\nDone. ${result.logins} logins, ${result.operators} operators and ${result.tricycles} tricycles kept.`);
  console.log("Next: sign in as the Manager, re-issue the tricycles, then add Supervisors and operator PINs.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
