/**
 * Log format:
 *   time [worker] job_id message 
 *   14:32:07.412 [w1]  job_a1b2c3d4  started (sleep 5000ms)
 *   14:32:12.418 [w1]  job_a1b2c3d4  finished in 5.006s
 *
 * The point of the format is that a job is traceable ACROSS processes. The API
 * and the worker will be running in the separate terminals; the only way to 
 * follow one job through both is if the same id is printed the same way in each.
 * That matters more when we run three workers are interleaving their output.
*/

// First 8 chars of the UUID is enough to be uniquely identify on screen, short enough to scan.
export function shortId(jobId: string): string {
  const sID = jobId.slice(0, 8);
  return `job_${sID}`;
}

function stamp(): string {
  // HH:MM:SS.mmm — the date is noise when everything happens within a minute.
  return new Date().toISOString().slice(11, 23);
}

export interface Logger {
  info(jobId: string | null, message: string): void;
  error(jobId: string | null, message: string): void;
}

/** @param actor short name for the process — "api", "w1", "w2". */
export function createLogger(actor: string): Logger {
  const format = (jobId: string | null, message: string) => {
    const id = jobId ? shortId(jobId) : "";
    return `${stamp()} [${actor.padEnd(3)}] ${id.padEnd(12)} ${message}`;
  };

  return {
    info: (jobId, message) => console.log(format(jobId, message)),
    error: (jobId, message) => console.error(format(jobId, message)),
  };
}
