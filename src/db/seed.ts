import { eq } from "drizzle-orm";
import { db, pgClient } from "./index";
import { users } from "./schema";
import { hashCredential } from "../services/auth";
import { normalizePhone } from "../lib/phone";

const EXAMPLE_PASSWORD = "dev-only-manager-pass";

async function main() {
  const { SEED_MANAGER_NAME, SEED_MANAGER_PHONE, SEED_MANAGER_PASSWORD } = process.env;
  if (!SEED_MANAGER_NAME || !SEED_MANAGER_PHONE || !SEED_MANAGER_PASSWORD) {
    throw new Error("Set SEED_MANAGER_NAME, SEED_MANAGER_PHONE and SEED_MANAGER_PASSWORD.");
  }
  if (process.env.NODE_ENV === "production" && SEED_MANAGER_PASSWORD === EXAMPLE_PASSWORD) {
    throw new Error("Refusing to seed production with the example password.");
  }
  const phone = normalizePhone(SEED_MANAGER_PHONE);
  if (!phone) throw new Error("SEED_MANAGER_PHONE is not a valid Nigerian mobile number.");

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.role, "manager")).limit(1);
  if (existing) {
    console.log("A Manager account already exists. Nothing changed.");
    return;
  }
  await db.insert(users).values({
    name: SEED_MANAGER_NAME,
    phone,
    role: "manager",
    credentialHash: await hashCredential(SEED_MANAGER_PASSWORD),
  });
  console.log("Manager account created.");
}

main().finally(() => pgClient.end());
