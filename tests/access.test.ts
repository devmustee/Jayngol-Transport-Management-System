import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, operators } from "@/db/schema";
import { DomainError, ForbiddenError } from "@/lib/errors";
import { issueTricycle } from "@/services/assignments";
import { listAudit } from "@/services/audit";
import { login, resolveSession } from "@/services/auth";
import type { Ctx } from "@/services/context";
import {
  createOperator,
  getMyPortal,
  getOperator,
  listOperators,
} from "@/services/operators";
import {
  createTricycle,
  listTricycles,
  updateTricycle,
} from "@/services/tricycles";
import { createStaff, setOperatorPin, setStaffStatus } from "@/services/users";
import {
  fixedClock,
  makeOperator,
  makeTricycle,
  makeUser,
  NOW,
  SECRET,
  TODAY,
  tricycleInput,
  uniquePhone,
} from "./helpers";

let manager: Ctx;
let owner: Ctx;
let supervisor: Ctx;

beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  owner = (await makeUser("owner")).ctx;
  supervisor = (await makeUser("supervisor")).ctx;
});

const after = (ms: number) => () => new Date(NOW.getTime() + ms);
let ipCounter = 0;
const ip = () => `10.0.0.${++ipCounter}`;

/** Creates an operator with a tricycle and a portal login. */
async function makePortalOperator() {
  const t = await makeTricycle(manager);
  const phone = uniquePhone();
  const o = await makeOperator(manager, { phone });
  await issueTricycle(manager, {
    tricycleId: t.id,
    operatorId: o.id,
    issuedOn: TODAY,
    dailyBalance: "12000",
  });
  await setOperatorPin(manager, o.id, { pin: "123456" });
  const { token } = await login({ phone, secret: "123456", ip: ip() }, fixedClock);
  const actor = (await resolveSession(token, fixedClock))!;
  const ctx: Ctx = { actor, clock: fixedClock };
  return { ctx, operatorId: o.id };
}

describe("tricycle register", () => {
  it("normalises identifiers and blocks duplicates", async () => {
    const input = tricycleInput({ registrationNumber: "kja  101 xy", codeNumber: "jt-dup" });
    await createTricycle(manager, input);
    await expect(
      createTricycle(manager, { ...tricycleInput(), registrationNumber: "KJA 101 XY" }),
    ).rejects.toMatchObject({
      fieldErrors: { registrationNumber: expect.stringContaining("already exists") },
    });
    await expect(
      createTricycle(manager, { ...tricycleInput(), codeNumber: "JT-DUP" }),
    ).rejects.toMatchObject({
      fieldErrors: { codeNumber: expect.stringContaining("already exists") },
    });
  });

  it("requires a purchase date, which cannot be in the future", async () => {
    await expect(
      createTricycle(manager, tricycleInput({ purchasedOn: "" })),
    ).rejects.toMatchObject({ fieldErrors: { purchasedOn: expect.any(String) } });
    await expect(
      createTricycle(manager, tricycleInput({ purchasedOn: "2026-11-11" })),
    ).rejects.toThrow(DomainError);
  });

  it("treats search wildcards as plain text", async () => {
    const rows = await listTricycles(manager, { q: "%" });
    expect(rows).toHaveLength(0);
  });
});

describe("roles", () => {
  it("makes the owner read-only", async () => {
    await expect(listTricycles(owner)).resolves.toBeDefined();
    await expect(createTricycle(owner, tricycleInput())).rejects.toThrow(ForbiddenError);
    await expect(createOperator(owner, {})).rejects.toThrow(ForbiddenError);
    await expect(createStaff(owner, {})).rejects.toThrow(ForbiddenError);
    await expect(listAudit(owner)).resolves.toBeDefined();
  });

  it("lets a supervisor view but not change, and hides guarantor details", async () => {
    const t = await makeTricycle(manager);
    await expect(updateTricycle(supervisor, t.id, tricycleInput())).rejects.toThrow(ForbiddenError);
    await expect(listAudit(supervisor)).rejects.toThrow(ForbiddenError);

    const o = await makeOperator(manager, {
      guarantorName: "Secret Guarantor",
      guarantorPhone: uniquePhone(),
      address: "Private address",
    });
    const seen = await getOperator(supervisor, o.id);
    expect(seen!.operator.guarantorName).toBeNull();
    expect(seen!.operator.guarantorPhone).toBeNull();
    expect(seen!.operator.address).toBeNull();
    expect((await getOperator(manager, o.id))!.operator.guarantorName).toBe("Secret Guarantor");
  });
});

describe("operator portal", () => {
  it("shows the operator only their own tricycle", async () => {
    const first = await makePortalOperator();
    const second = await makePortalOperator();
    const a = await getMyPortal(first.ctx);
    const b = await getMyPortal(second.ctx);
    expect(a.current!.codeNumber).not.toBe(b.current!.codeNumber);
    expect(a.dailyBalanceKobo).toBe(1_200_000);
  });

  it("blocks operators from every staff read", async () => {
    const { ctx, operatorId } = await makePortalOperator();
    await expect(listTricycles(ctx)).rejects.toThrow(ForbiddenError);
    await expect(listOperators(ctx)).rejects.toThrow(ForbiddenError);
    await expect(getOperator(ctx, operatorId)).rejects.toThrow(ForbiddenError);
    await expect(listAudit(ctx)).rejects.toThrow(ForbiddenError);
  });

  it("blocks staff from the portal view", async () => {
    await expect(getMyPortal(manager)).rejects.toThrow(ForbiddenError);
  });
});

describe("login", () => {
  it("locks after 5 wrong attempts, then unlocks after 15 minutes", async () => {
    const { user } = await makeUser("supervisor");
    const phone = user.phone;
    for (let i = 0; i < 4; i++) {
      await expect(login({ phone, secret: "wrong-pass", ip: ip() }, fixedClock)).rejects.toThrow(
        /Wrong phone number/,
      );
    }
    await expect(login({ phone, secret: "wrong-pass", ip: ip() }, fixedClock)).rejects.toThrow(
      /Too many/,
    );
    await expect(login({ phone, secret: SECRET, ip: ip() }, fixedClock)).rejects.toThrow(/Too many/);
    await expect(
      login({ phone, secret: SECRET, ip: ip() }, after(15 * 60 * 1000 + 1)),
    ).resolves.toBeDefined();
  });

  it("limits repeated failures from one address across many phones", async () => {
    const address = "10.9.9.9";
    for (let i = 0; i < 30; i++) {
      await expect(
        login({ phone: uniquePhone(), secret: "x-wrong-x", ip: address }, fixedClock),
      ).rejects.toThrow(/Wrong phone number/);
    }
    await expect(
      login({ phone: uniquePhone(), secret: "x-wrong-x", ip: address }, fixedClock),
    ).rejects.toThrow(/Too many/);
  });

  it("gives the same answer for an unknown phone and a wrong password", async () => {
    const { user } = await makeUser("supervisor");
    const unknown = await login({ phone: uniquePhone(), secret: "nope-nope", ip: ip() }, fixedClock).catch((e: Error) => e.message);
    const wrong = await login({ phone: user.phone, secret: "nope-nope", ip: ip() }, fixedClock).catch((e: Error) => e.message);
    expect(unknown).toBe(wrong);
  });

  it("ends staff sessions after 12 idle hours", async () => {
    const { user } = await makeUser("supervisor");
    const { token } = await login({ phone: user.phone, secret: SECRET, ip: ip() }, fixedClock);
    expect(await resolveSession(token, after(11 * 3600 * 1000))).not.toBeNull();
    expect(await resolveSession(token, after(11 * 3600 * 1000 + 13 * 3600 * 1000))).toBeNull();
  });

  it("stops a disabled user at once and refuses new logins", async () => {
    const { user } = await makeUser("supervisor");
    const { token } = await login({ phone: user.phone, secret: SECRET, ip: ip() }, fixedClock);
    await setStaffStatus(manager, user.id, "disabled");
    expect(await resolveSession(token, fixedClock)).toBeNull();
    await expect(login({ phone: user.phone, secret: SECRET, ip: ip() }, fixedClock)).rejects.toThrow(
      DomainError,
    );
  });

  it("does not let a Manager disable themselves", async () => {
    await expect(setStaffStatus(manager, manager.actor.userId, "disabled")).rejects.toThrow(
      /your own login/,
    );
  });
});

describe("audit log", () => {
  it("records who changed what and never stores a credential", async () => {
    const t = await makeTricycle(manager);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.entityId, t.id));
    expect(row).toMatchObject({ action: "tricycle.create", actorUserId: manager.actor.userId });

    const staff = (await createStaff(manager, {
      name: "New Supervisor",
      phone: uniquePhone(),
      role: "supervisor",
      password: "a-long-password",
    }))!;
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.entityId, staff.id));
    expect(JSON.stringify(entry)).not.toContain("a-long-password");
    expect(JSON.stringify(entry)).not.toMatch(/credential|\$2[aby]\$/);
  });

  it("cannot be edited, deleted or truncated", async () => {
    await expect(db.execute(sql`UPDATE audit_log SET action = 'x'`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM audit_log`)).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE audit_log`)).rejects.toThrow();
  });

  it("is not written when the change fails", async () => {
    const before = await db.$count(auditLog);
    const dup = tricycleInput();
    await createTricycle(manager, dup);
    await expect(createTricycle(manager, dup)).rejects.toThrow(DomainError);
    expect(await db.$count(auditLog)).toBe(before + 1);
  });
});

describe("portal login when adding an operator", () => {
  const PIN = "482915";
  const operatorRow = async (phone: string) => {
    const rows = await db.select().from(operators).where(eq(operators.phone, phone));
    return rows[0];
  };
  const asStored = (phone: string) => `+234${phone.slice(1)}`;

  it("lets the new operator sign in with the PIN", async () => {
    const phone = uniquePhone();
    const created = await makeOperator(manager, { phone, pin: PIN });
    const result = await login({ phone, secret: PIN, ip: "10.9.9.1" }, fixedClock);
    expect(result.role).toBe("operator");
    const row = await operatorRow(asStored(phone));
    expect(row).toMatchObject({ id: created.id });
    expect(row!.userId).not.toBeNull();
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "operator.set_pin"), eq(auditLog.entityId, created.id)));
    expect(JSON.stringify(audit)).not.toContain(PIN);
  });

  it("creates no login when the PIN is left empty", async () => {
    const phone = uniquePhone();
    await makeOperator(manager, { phone, pin: "" });
    expect((await operatorRow(asStored(phone)))!.userId).toBeNull();
  });

  it("saves nothing when the PIN is invalid", async () => {
    const phone = uniquePhone();
    await expect(makeOperator(manager, { phone, pin: "12" })).rejects.toMatchObject({ fieldErrors: { pin: expect.anything() } });
    expect(await operatorRow(asStored(phone))).toBeUndefined();
  });

  it("saves nothing when the phone already has a staff login", async () => {
    const { user } = await makeUser("supervisor");
    const phone = `0${user.phone.slice(4)}`;
    await expect(makeOperator(manager, { phone, pin: PIN })).rejects.toMatchObject({ fieldErrors: { phone: expect.anything() } });
    expect(await operatorRow(user.phone)).toBeUndefined();
  });
});
