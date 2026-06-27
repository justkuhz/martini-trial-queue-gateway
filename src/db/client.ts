import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "../config/env";

const pool = new Pool({
  connectionString: env.databaseUrl,
});

export const db = drizzle(pool);

export async function closeDb(): Promise<void> {
  await pool.end();
}

