import postgres from "postgres";
import { runMigrations } from "../src/db/migrate";

/** Every test run starts from a freshly migrated database. */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jayngol_test");
  const name = url.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error("Tests only run against a *_test database.");

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();

  await runMigrations(url.toString());
}
