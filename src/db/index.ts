import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

type Client = ReturnType<typeof postgres>;
const cache = globalThis as unknown as { __jayngolPg?: Client };

// Production must use Supabase's Session pooler (port 5432): the dashboard hangs
// on the Transaction pooler (6543). That pooler has a limited total of
// connections shared by every server instance, so each one takes only 5.
const client = cache.__jayngolPg ?? postgres(url, { prepare: false, max: 5 });
if (process.env.NODE_ENV !== "production") cache.__jayngolPg = client;

export const db: PostgresJsDatabase<typeof schema> = drizzle(client, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;
export { client as pgClient };
