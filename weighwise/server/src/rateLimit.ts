// Simple in-memory fixed-window limiter. Single-instance only; move to Redis when scaling out.
const hits = new Map<string, { n: number; reset: number }>();

export function hit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || e.reset <= now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  e.n += 1;
  return e.n <= limit;
}

export const resetRateLimits = () => hits.clear();
