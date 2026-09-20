// @effect-diagnostics globalDate:off - This standalone Node control-plane helper uses wall-clock windows.
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<
    string,
    { readonly startedAt: number; readonly count: number }
  >();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  consume(key: string, now = Date.now()): boolean {
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      this.prune(now);
      return true;
    }
    if (current.count >= this.limit) return false;
    this.buckets.set(key, { startedAt: current.startedAt, count: current.count + 1 });
    return true;
  }

  private prune(now: number): void {
    if (this.buckets.size < 10_000) return;
    for (const [key, value] of this.buckets) {
      if (now - value.startedAt >= this.windowMs) this.buckets.delete(key);
    }
  }
}
