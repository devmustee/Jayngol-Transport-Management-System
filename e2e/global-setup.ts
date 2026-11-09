import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import postgres from "postgres";
import { BASE_URL, DATABASE_URL, idsPath, OWNER_PHONE, statePath, type AuditRole } from "./config";

/** Logs each role in once through the real form, and finds records to open. */
export default async function globalSetup() {
  const password = process.env.SEED_MANAGER_PASSWORD!;
  const logins: Record<AuditRole, { phone: string; secret: string }> = {
    owner: { phone: OWNER_PHONE, secret: password },
    manager: { phone: process.env.SEED_MANAGER_PHONE!, secret: password },
    assistant_manager: { phone: "08000001901", secret: password },
    supervisor: { phone: "08000001902", secret: password },
    operator: { phone: "08000001001", secret: "482615" },
  };
  mkdirSync("e2e/.auth", { recursive: true });
  const browser = await chromium.launch();
  for (const [role, login] of Object.entries(logins) as [AuditRole, (typeof logins)[AuditRole]][]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel("Phone number").fill(login.phone);
    await page.getByLabel("Password or PIN").fill(login.secret);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.waitForURL((url) => url.pathname !== "/login", { timeout: 20_000 });
    await context.storageState({ path: statePath(role) });
    await context.close();
  }
  await browser.close();

  const sql = postgres(DATABASE_URL, { max: 1 });
  const one = async (query: Promise<{ id: string }[]>) => (await query)[0]?.id ?? "missing";
  const ids = {
    tricycle: await one(sql`SELECT tricycle_id AS id FROM work_orders GROUP BY tricycle_id ORDER BY COUNT(*) DESC LIMIT 1`),
    operator: await one(sql`SELECT operator_id AS id FROM violations GROUP BY operator_id ORDER BY COUNT(*) DESC LIMIT 1`),
    payment: await one(sql`SELECT id FROM payments ORDER BY created_at DESC LIMIT 1`),
    meeting: await one(sql`SELECT id FROM meetings WHERE status = 'closed' ORDER BY scheduled_for DESC LIMIT 1`),
    workOrder: await one(sql`SELECT work_order_id AS id FROM stock_movements WHERE work_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`),
    item: await one(sql`SELECT item_id AS id FROM stock_movements GROUP BY item_id ORDER BY COUNT(*) DESC LIMIT 1`),
  };
  await sql.end();
  writeFileSync(idsPath, JSON.stringify(ids));
}
