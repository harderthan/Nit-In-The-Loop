/** Runs refreshes serially, merging any number of requests made during a run. */
export class CoalescedRefresh {
  private running = false;
  private requested = false;
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(private readonly refresh: () => Promise<void>) {}

  get isRunning(): boolean { return this.running; }

  request(): Promise<void> {
    this.requested = true;
    const completed = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (!this.running) {
      this.running = true;
      void this.drain();
    }
    return completed;
  }

  private async drain(): Promise<void> {
    let failed = false;
    let failure: unknown;
    while (this.requested) {
      this.requested = false;
      try {
        await this.refresh();
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
    this.running = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      if (failed) waiter.reject(failure);
      else waiter.resolve();
    }
  }
}
