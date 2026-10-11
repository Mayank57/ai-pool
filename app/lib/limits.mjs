// In-memory sliding-window counters for abuse limits (per IP, per email, per user).
// Good enough for one process; the window is short so memory stays bounded.
export class Limiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => this.prune(), 60000);
    this.timer.unref?.();
  }

  bucket(key, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now - b.since > windowMs) {
      b = { since: now, count: 0, windowMs };
      this.buckets.set(key, b);
    }
    return b;
  }

  // Counts one attempt; returns false when the limit is exceeded.
  hit(key, max, windowMs) {
    const b = this.bucket(key, windowMs);
    b.count++;
    return b.count <= max;
  }

  // Reports whether another attempt would be allowed, without counting it.
  allowed(key, max, windowMs) {
    const b = this.buckets.get(key);
    return !b || Date.now() - b.since > windowMs || b.count < max;
  }

  reset(key) {
    this.buckets.delete(key);
  }

  prune() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now - b.since > b.windowMs) this.buckets.delete(k);
  }
}
