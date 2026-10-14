/**
 * Input hygiene helpers.
 *
 * The client renders everything as text nodes (never `innerHTML`), and these
 * helpers strip control characters and clamp sizes server-side so stored data
 * is clean no matter which client wrote it.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Strip control/zero-width characters and collapse runaway whitespace. */
export function sanitizeText(input: string): string {
  return input.replace(CONTROL_CHARS, "").replace(ZERO_WIDTH, "").trim();
}

/** Clamp a text field to `max` characters. */
export function clampText(input: string, max: number): string {
  const clean = sanitizeText(input);
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** Only allow http(s) URLs (used for custom avatars). */
export function sanitizeUrl(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const value = input.trim();
  if (value.length === 0 || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

const AVATAR_COLORS = [
  "#6366f1",
  "#ec4899",
  "#f97316",
  "#10b981",
  "#0ea5e9",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#eab308",
  "#3b82f6",
] as const;

/** Deterministic avatar colour so a user keeps the same swatch everywhere. */
export function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] as string;
}

/** Turn a display name into a URL-safe, lowercase handle. */
export function toHandle(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .slice(0, 24);
  return base.length >= 2 ? base : `guest${Math.floor(Math.random() * 9000 + 1000)}`;
}