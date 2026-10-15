/** Owns one file watcher per active review store. */
export class StoreWatchers {
  private readonly stops = new Map<string, () => void>();

  constructor(private readonly watch: (path: string) => () => void) {}

  ensure(path: string): void {
    if (!this.stops.has(path)) this.stops.set(path, this.watch(path));
  }

  retain(paths: Iterable<string>): void {
    const active = new Set(paths);
    for (const [path, stop] of this.stops) {
      if (!active.has(path)) {
        stop();
        this.stops.delete(path);
      }
    }
  }

  dispose(): void {
    this.retain([]);
  }
}
