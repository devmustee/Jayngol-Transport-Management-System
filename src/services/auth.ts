import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, count, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { loginFailures, operators, sessions, users } from "@/db/schema";
import type { Clock } from "@/lib/clock";
import { DomainError } from "@/lib/errors";
import { normalizePhone } from "@/lib/phone";
import { recordAudit } from "./audit";
import type { Actor } from "./context";

const BCRYPT_COST = 10;
const MAX_ACCOUNT_FAILURES = 5;
const MAX_IP_FAILURES = 30;
const WINDOW_MS = 15 * 60 * 1000;
const STAFF_IDLE_MS = 12 * 60 * 60 * 1000;
const OPERATOR_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_AFTER_MS = 5 * 60 * 1000;

const INVALID = "Wrong phone number or password.";
const LOCKED = "Too many wrong attempts. Try again after 15 minutes.";

export const hashCredential = (secret: string) => bcrypt.hash(secret, BCRYPT_COST);
export const verifyCredential = (secret: string, hash: string) =>
  bcrypt.compare(secret, hash);

// Comparing against this when the phone is unknown keeps response times equal.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashCredential(randomBytes(16).toString("hex")));

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const idleLimit = (role: Actor["role"]) =>
  role === "operator" ? OPERATOR_IDLE_MS : STAFF_IDLE_MS;

export type LoginInput = { phone: string; secret: string; ip: string };

export async function login(input: LoginInput, clock: Clock) {
  const now = clock();
  const since = new Date(now.getTime() - WINDOW_MS);

  const [ipFailures] = await db
    .select({ value: count() })
    .from(loginFailures)
    .where(and(eq(loginFailures.ip, input.ip), gt(loginFailures.at, since)));
  if ((ipFailures?.value ?? 0) >= MAX_IP_FAILURES) throw new DomainError(LOCKED);

  const phone = normalizePhone(input.phone);
  const [user] = phone
    ? await db.select().from(users).where(eq(users.phone, phone)).limit(1)
    : [];

  const fail = async () => {
    await db.insert(loginFailures).values({ ip: input.ip, at: now });
    return new DomainError(INVALID);
  };

  if (!user) {
    await verifyCredential(input.secret, await getDummyHash());
    throw await fail();
  }
  if (user.lockedUntil && user.lockedUntil > now) throw new DomainError(LOCKED);

  const correct = await verifyCredential(input.secret, user.credentialHash);
  if (!correct) {
    const failures = user.failedAttempts + 1;
    const lock = failures >= MAX_ACCOUNT_FAILURES;
    await db
      .update(users)
      .set({
        failedAttempts: lock ? 0 : failures,
        lockedUntil: lock ? new Date(now.getTime() + WINDOW_MS) : null,
      })
      .where(eq(users.id, user.id));
    if (lock) {
      await recordAudit(db, null, now, {
        action: "auth.locked",
        entityType: "user",
        entityId: user.id,
      });
      await db.insert(loginFailures).values({ ip: input.ip, at: now });
      throw new DomainError(LOCKED);
    }
    throw await fail();
  }

  if (user.status !== "active") throw await fail();

  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: now })
      .where(eq(users.id, user.id));
    await tx.insert(sessions).values({
      tokenHash: hashToken(token),
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + idleLimit(user.role)),
    });
    await recordAudit(tx, { userId: user.id, role: user.role }, now, {
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
    });
  });
  // Housekeeping: failures older than a day no longer affect anything.
  await db
    .delete(loginFailures)
    .where(lt(loginFailures.at, new Date(now.getTime() - 24 * 60 * 60 * 1000)));

  return { token, role: user.role };
}

export async function resolveSession(token: string, clock: Clock): Promise<Actor | null> {
  const now = clock();
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ session: sessions, user: users, operatorId: operators.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(operators, eq(operators.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;

  if (row.session.expiresAt <= now || row.user.status !== "active") {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }
  if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
    await db
      .update(sessions)
      .set({
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + idleLimit(row.user.role)),
      })
      .where(eq(sessions.tokenHash, tokenHash));
  }
  return {
    userId: row.user.id,
    name: row.user.name,
    role: row.user.role,
    operatorId: row.operatorId,
  };
}

export async function endSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
