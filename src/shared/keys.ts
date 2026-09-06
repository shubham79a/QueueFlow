/**
 * Every Redis key name this system uses, defined exactly once.
 *
 * The API and the worker are separate processes that never import each other and
 * never share memory. The ONLY thing connecting them is that both send the string
 * "queueflow:pending" to Redis. If one of them ever sends "queueflow:pendings",
 * nothing errors — Redis happily creates a second, empty list, the API keeps
 * returning 202, and the worker blocks forever on a queue nobody writes to.
 *
 * That is a silent, hours-long bug, and it is caused by a typo in a string literal.
 * Naming the key in one file turns it into an import error instead.
 */
export const KEYS = {
  /** LIST — jobs waiting to be picked up. Producer LPUSHes, worker BRPOPs. */
  pending: "queueflow:pending",

  /**
   * ZSET — jobs waiting out a retry backoff, scored by the epoch-ms they become
   * due. A sorted set rather than a list because the question being asked is
   * "which of these are due now?", and ZRANGEBYSCORE answers it in log time
   * without scanning. A list can only answer "what is at the end?".
   */
  delayed: "queueflow:delayed",
} as const;
