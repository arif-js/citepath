/**
 * Single-consumer async queue: producers push values; the consumer iterates with
 * `for await`. Used to stream crawl outcomes to sync while fetches run concurrently.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private rejectWaiting: ((err: unknown) => void) | undefined;
  private closed = false;
  private error: unknown;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      this.rejectWaiting = undefined;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      this.rejectWaiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  fail(err: unknown): void {
    this.error = err;
    this.closed = true;
    if (this.rejectWaiting) {
      const reject = this.rejectWaiting;
      this.waiting = undefined;
      this.rejectWaiting = undefined;
      reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.error !== undefined) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = resolve;
          this.rejectWaiting = reject;
        });
      },
    };
  }
}
