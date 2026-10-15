/**
 * Spaces requests to one host: at most one request starts every `intervalMs`.
 * Concurrency is limited separately; this only enforces politeness between starts.
 */
export class RateLimiter {
  private nextStart = 0;

  constructor(
    private intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  setInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
  }

  /** Delays the next request start (e.g. after a Retry-After response). */
  pushBack(delayMs: number): void {
    this.nextStart = Math.max(this.nextStart, this.now() + delayMs);
  }

  async wait(): Promise<void> {
    const now = this.now();
    const start = Math.max(now, this.nextStart);
    this.nextStart = start + this.intervalMs;
    if (start > now) await this.sleep(start - now);
  }
}
