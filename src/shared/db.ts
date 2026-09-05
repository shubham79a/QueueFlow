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

    /**
     * Sized from concurrency, not fixed.
     *
     * Every job in flight needs a connection to itself while it commits — the
     * transaction in the worker checks one out with db.connect() and holds it
     * until COMMIT. So a worker running N jobs concurrently can need N
     * connections at the same instant, plus a spare for the SELECT and the claim.
     *
     * Hardcoding this too low does not error, which is what makes it nasty: jobs
     * simply queue up inside the pool waiting for a connection, throughput
     * flatlines, and nothing in any log says why. Too high is not free either —
     * Postgres runs a separate backend process per connection, so ten workers
     * with a generous pool each will exhaust max_connections on the server.
     */
    max: Math.max(4, Number(process.env.CONCURRENCY ?? 1) + 2),
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
