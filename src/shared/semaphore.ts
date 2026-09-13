// A counting semaphore: at most N holders at a time.
// Twenty lines, no dependency. It exists so the worker can stop pulling work off
// Redis when it has no capacity to run it.
// `acquire()` returns immediately while permits remain, and otherwise returns a
// promise that resolves when someone calls `release()`. Waiters are served in
// arrival order, so a slot cannot be starved by later arrivals.

export class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`semaphore capacity must be a positive integer, got ${capacity}`);
    }
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    // No permit. Park until someone releases one. FIFO, so no starvation.
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Hand the permit straight to the next waiter rather than incrementing and
      // letting them re-check — that would leave a window where a newly arriving
      // caller could take the permit ahead of someone already queued.
      next();
      return;
    }
    if (this.available < this.capacity) this.available += 1;
  }

  // In-flight count, for logging and for the drain check on shutdown.
  get inFlight(): number {
    return this.capacity - this.available;
  }
}
