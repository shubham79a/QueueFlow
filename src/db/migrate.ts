import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createDb } from "../shared/db.js";
import { createLogger } from "../shared/log.js";

/**
 * Applies db/schema.sql. That is the whole migration system.
 *
 * A real project outgrows this — it has no version tracking, so it can only apply
 * a schema that is safe to re-run, which is why everything in schema.sql is
 * IF NOT EXISTS. What it buys in exchange is that the schema stays a plain SQL
 * file you can read top to bottom, which is the point: the CHECK constraint and
 * the UNIQUE index are things to understand, not things for a tool to hide.
 */
const log = createLogger("db");

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "../../db/schema.sql");

async function main(): Promise<void> {
  const sql = readFileSync(schemaPath, "utf8");
  const pool = createDb("migrate", log);

  log.info(null, `applying ${schemaPath}`);
  await pool.query(sql);

  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );

  log.info(null, `ok. tables: ${tables.rows.map((r) => r.table_name).join(", ")}`);
  await pool.end();
}

main().catch((err) => {
  log.error(null, `migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
