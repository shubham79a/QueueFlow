import { Pool, type QueryResultRow } from "pg";
import type { Logger } from "./log.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://queueflow:queueflow@127.0.0.1:5433/queueflow";

// A Postgres connection pool.
// We have seen createRedis() return only one connection, but createDb() returns a pool. Why the difference?
// Postgres queries are short and finite, so a pool is better than one connection per query. 
// Redis BRPOP/BLMOVE blocks indefinitely, so a single connection cannot be shared for other commands.
// So sharing a handful between all callers is strictly better than opening one per query: a TCP connect plus
// authentication per query would cost more than the queries themselves.

export function createDb(name: string, log: Logger): Pool {
  const pool = new Pool({
    connectionString: DATABASE_URL,

    // Sized based on concurrency, not fixed.
    // Every job in flight needs a connection to itself while it commits — the transaction in the worker checks one out with db.connect() and holds it
    // until COMMIT. So a worker running N jobs concurrently can need N connections at the same instant, plus a spare for the SELECT and the claim.

    // too low pool size: jobs will be queued inside the pool waiting for a connection, throughput flatlines, logs will show nothing.
    // too high pool size: Postgres runs a separate backend process per connection, so ten workers with a generous pool each will exhaust max_connections on the server.

    max: Math.max(4, Number(process.env.CONCURRENCY ?? 1) + 2),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Pools emit 'error' for idle clients dropped by the server. Without a listener
  // an EventEmitter 'error' is rethrown and kills the process.
  pool.on("error", (err: Error) => log.error(null, `pg[${name}] idle client: ${err.message}`));

  return pool;
}

// Typed query helper. Exists so call sites read as SQL rather than as pg ceremony.

// `$1, $2` are placeholders — the values travel to Postgres separately from the
// SQL text, so a payload containing `'; DROP TABLE jobs; --` is data and can never
// be parsed as SQL. This is parameterisation, and it is why no string
// concatenation appears anywhere near a query in this project.

export async function query<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}
