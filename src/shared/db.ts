import { Pool, type QueryResultRow } from "pg";
import type { Logger } from "./log.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://queueflow:queueflow@127.0.0.1:5433/queueflow";

/**
 * A Postgres connection pool.
 *
 * Note the difference from createRedis(): that returns ONE connection, because a
 * connection blocked on BRPOP can carry nothing else. This returns a POOL — a set
 * of connections the driver hands out per query and takes back afterwards.
 *
 * The reason for the difference is that Postgres queries are short and finite.
 * Nothing here parks a connection indefinitely, so sharing a handful between all
 * callers is strictly better than opening one per query: a TCP connect plus
 * authentication per query would cost more than the queries themselves.
 */
export function createDb(name: string, log: Logger): Pool {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    // Small on purpose. Each worker process needs a couple of connections at
    // most, and Postgres charges real memory per backend — the default of 10 per
    // process stops being free once Phase 3 runs ten workers.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Pools emit 'error' for idle clients dropped by the server. Without a listener
  // an EventEmitter 'error' is rethrown and kills the process.
  pool.on("error", (err: Error) => log.error(null, `pg[${name}] idle client: ${err.message}`));

  return pool;
}

/**
 * Typed query helper. Exists so call sites read as SQL rather than as pg ceremony.
 *
 * `$1, $2` are placeholders — the values travel to Postgres separately from the
 * SQL text, so a payload containing `'; DROP TABLE jobs; --` is data and can never
 * be parsed as SQL. This is parameterisation, and it is why no string
 * concatenation appears anywhere near a query in this project.
 */
export async function query<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}
