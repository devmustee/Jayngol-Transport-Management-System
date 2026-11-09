/**
 * Builds the throwaway jayngol_audit database as a copy of the sample data, so
 * audit logins and sessions never touch the sample or development databases.
 * Adds an Owner, the one role the sample data does not include.
 */
import { execSync } from "node:child_process";
import postgres from "postgres";
import { hashCredential } from "../src/services/auth";
import { AUDIT_DATABASE, OWNER_PHONE, SOURCE_DATABASE } from "./config";

async function main() {
  const password = process.env.SEED_MANAGER_PASSWORD;
  if (!password) throw new Error("Set SEED_MANAGER_PASSWORD in .env.local.");
  if (!process.env.DATABASE_URL?.endsWith(`/${AUDIT_DATABASE}`)) {
    throw new Error(`Refusing to run against anything but ${AUDIT_DATABASE}.`);
  }
  execSync(`dropdb --if-exists ${AUDIT_DATABASE} && createdb ${AUDIT_DATABASE}`, { stdio: "inherit" });
  execSync(`pg_dump --no-owner ${SOURCE_DATABASE} | psql -q -v ON_ERROR_STOP=1 ${AUDIT_DATABASE} > /dev/null`, {
    stdio: "inherit",
    shell: "/bin/bash",
  });
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const hash = await hashCredential(password);
    await sql`INSERT INTO users (name, phone, role, credential_hash) VALUES ('Audit Owner', ${OWNER_PHONE}, 'owner', ${hash})`;
  } finally {
    await sql.end();
  }
  console.log(`${AUDIT_DATABASE} is ready.`);
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
