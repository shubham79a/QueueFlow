// Named import, not default: ioredis is CommonJS, and under NodeNext + ESM the
// named `Redis` export is the one that resolves to a constructible class type.
import { Redis } from "ioredis";
import type { Logger } from "./log.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

// Creates one Redis connection.
// Every Worker → 2 connections (one waits, one works)
// "One" is deliberate, and it is the reason this is a factory rather than a
// shared singleton export. A connection blocked on BLMOVE cannot carry any other
// command. A process that needs to both block on the queue and do anything else
// needs two connections, so the code has to be able to ask for another one.

export function createRedis(name: string, log: Logger): Redis {
  const redis = new Redis(REDIS_URL, {
    // ioredis default: a command queued while disconnected is retried 20 times,
    // then rejected with "max retries per request".

    // That default is wrong for this project. `BLMOVE ... 0` is supposed to block
    // indefinitely — that is the whole point of it. With the default, a Redis
    // restart would make the worker's blocking call throw instead of resuming, and
    // the worker would fall out of its loop for a reason that has nothing to do
    // with the queue. null = queue the command and wait for the connection back.

    maxRetriesPerRequest: null,

    // Try to reconnect within a short duration backoff instead of hammering a dead server.
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),

    connectionName: `queueflow:${name}`,
  });

  redis.on("connect", () => log.info(null, `redis[${name}] connected`));
  redis.on("error", (err: Error) => log.error(null, `redis[${name}] ${err.message}`));
  redis.on("reconnecting", () => log.info(null, `redis[${name}] reconnecting...`));

  return redis;
}
