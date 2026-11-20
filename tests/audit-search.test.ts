import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { AUDIT_ACTIONS, AUDIT_GROUPS } from "@/lib/audit-actions";
import { ForbiddenError } from "@/lib/errors";
import { AUDIT_PER_PAGE, listAudit, recordAudit } from "@/services/audit";
import type { Ctx } from "@/services/context";
import { makeUser } from "./helpers";

let manager: Ctx;
let owner: Ctx;
let clerk: Ctx;
const tag = randomUUID().slice(0, 8);
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  owner = (await makeUser("owner")).ctx;
  clerk = (await makeUser("assistant_manager")).ctx;
  const entry = (action: string, reason?: string) => ({ action, entityType: "test", entityId: `${tag}-${action}`, reason });
  // 23:30 on 1 Feb in Lagos is still 1 Feb there, though 22:30 UTC.
  await recordAudit(db, clerk.actor, at("2039-02-01T23:30:00+01:00"), entry("payment.reverse", `Wrong operator ${tag}`));
  await recordAudit(db, clerk.actor, at("2039-02-02T00:30:00+01:00"), entry("cash.close"));
  await recordAudit(db, null, at("2039-02-02T09:00:00+01:00"), entry("violation.auto_fine", `Auto ${tag}`));
  await recordAudit(db, manager.actor, at("2039-02-03T09:00:00+01:00"), entry("balance.waive", `Forgiven ${tag}`));
});

const ids = (rows: { entityId: string }[]) => rows.map((row) => row.entityId.replace(`${tag}-`, "")).sort();

describe("audit log search", () => {
  it("is for the Owner and Manager only", async () => {
    await expect(listAudit(owner)).resolves.toBeDefined();
    await expect(listAudit(clerk)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("finds words in the reason, the name or the action", async () => {
    expect(ids((await listAudit(manager, { q: tag })).rows)).toEqual(["balance.waive", "cash.close", "payment.reverse", "violation.auto_fine"]);
    expect(ids((await listAudit(manager, { q: `wrong operator ${tag}` })).rows)).toEqual(["payment.reverse"]);
    const byName = await listAudit(manager, { q: clerk.actor.name });
    expect(byName.rows.every((row) => row.actorName === clerk.actor.name)).toBe(true);
    expect(byName.total).toBeGreaterThanOrEqual(2);
    const byAction = await listAudit(manager, { q: "reversed a payment", from: "2039-02-01", to: "2039-02-01" });
    expect(ids(byAction.rows)).toEqual(["payment.reverse"]);
    // A % is a plain character, not a wildcard.
    expect((await listAudit(manager, { q: "%" })).rows.every((row) => (row.reason ?? "").includes("%"))).toBe(true);
  });

  it("narrows by person, by the app itself, and by action or group", async () => {
    const days = { from: "2039-02-01", to: "2039-02-03" };
    expect(ids((await listAudit(manager, { ...days, who: clerk.actor.userId })).rows)).toEqual(["cash.close", "payment.reverse"]);
    expect(ids((await listAudit(manager, { ...days, who: "system" })).rows)).toEqual(["violation.auto_fine"]);
    expect(ids((await listAudit(manager, { ...days, what: "balance.waive" })).rows)).toEqual(["balance.waive"]);
    const fines = AUDIT_GROUPS.findIndex((group) => group.label === "Balances and fines");
    expect(ids((await listAudit(manager, { ...days, what: `group:${fines}` })).rows)).toEqual(["balance.waive", "violation.auto_fine"]);
  });

  it("counts days in Lagos time, and takes the dates either way round", async () => {
    expect(ids((await listAudit(manager, { from: "2039-02-01", to: "2039-02-01" })).rows)).toEqual(["payment.reverse"]);
    const swapped = await listAudit(manager, { from: "2039-02-02", to: "2039-02-01" });
    expect(ids(swapped.rows)).toEqual(["cash.close", "payment.reverse", "violation.auto_fine"]);
    expect(swapped.filter).toMatchObject({ from: "2039-02-01", to: "2039-02-02" });
  });

  it("ignores filters it does not understand", async () => {
    const odd = await listAudit(manager, { who: "nobody", what: "drop table", from: "yesterday", page: -3 });
    expect(odd.filtered).toBe(false);
    expect(odd.page).toBe(1);
    expect(odd.filter).toEqual({ who: null, what: null, from: null, to: null, q: null });
  });

  it("goes a page at a time, newest first", async () => {
    const first = await listAudit(manager);
    expect(first.rows.length).toBeLessThanOrEqual(AUDIT_PER_PAGE);
    const sorted = [...first.rows].sort((a, b) => b.id - a.id);
    expect(first.rows.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
    if (first.pages > 1) {
      const second = await listAudit(manager, { page: 2 });
      expect(second.rows[0]!.id).toBeLessThan(first.rows.at(-1)!.id);
    }
    expect((await listAudit(manager, { page: first.pages + 1 })).rows).toEqual([]);
  });
});

describe("audit action names", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });

  it("has words for every action the app records", () => {
    const recorded = new Set<string>();
    for (const file of files("src")) {
      for (const match of readFileSync(file, "utf8").matchAll(/action:[^,\n]*/g)) {
        for (const [name] of match[0].matchAll(/(?<=["'`])[a-z]+\.[a-z_]+(?=["'`])/g)) recorded.add(name);
      }
    }
    expect(recorded.size).toBeGreaterThan(50);
    expect([...recorded].filter((action) => !(action in AUDIT_ACTIONS))).toEqual([]);
  });
});
