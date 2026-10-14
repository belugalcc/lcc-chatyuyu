/**
 * Best-effort, per-isolate rate limiting.
 *
 * Durable Object instances are single-threaded, so a plain Map is enough to
 * keep a single chatty client from flooding a room. It is intentionally
 * approximate — a hard global guarantee would need Durable Object storage or
 * a rate-limiting product, which is out of scope for the free tier.
 */

interface Window {
  hits: number[];
}

const windows = new Map<string, Window>();

/** Drop stale windows so a long-lived isolate cannot grow without bound. */
function sweep(now: number): void {
  if (windows.size < 512) return;
  for (const [key, window] of windows) {
    if (window.hits.length === 0 || now - (window.hits[0] as number) > 60_000) windows.delete(key);
  }
}

/**
 * Record a hit for `key`.
 * @returns true when the caller is over the limit.
 */
export function hit(key: string, limit: number, windowMs = 10_000, now = Date.now()): boolean {
  sweep(now);
  const window = windows.get(key) ?? { hits: [] };
  const cutoff = now - windowMs;
  window.hits = window.hits.filter((time) => time > cutoff);
  window.hits.push(now);
  windows.set(key, window);
  return window.hits.length > limit;
}

/** Seconds the caller should wait before retrying (0 when not limited). */
export function retryAfter(key: string, windowMs = 10_000, now = Date.now()): number {
  const window = windows.get(key);
  if (!window || window.hits.length === 0) return 0;
  const oldest = window.hits[0] as number;
  const remaining = oldest + windowMs - now;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / 1000);
}

export function clearWindow(key: string): void {
  windows.delete(key);
}