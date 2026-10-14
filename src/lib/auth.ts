import { ApiError } from "./errors";
import type { Env } from "./types";

/**
 * lcc-chat has **no sign-up**.
 *
 * A visitor picks a display name once; the Worker mints a long-lived,
 * HMAC-signed session token that the browser keeps in `localStorage`. There is
 * no password, email, or third-party identity provider anywhere in the flow.
 *
 * The user id is *always* derived from the token signature — never from the
 * request body — so a client cannot act as somebody else.
 */

const TOKEN_VERSION = "lcc1";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export interface TokenClaims {
  /** user id */
  sub: string;
  /** issued at, seconds */
  iat: number;
  /** expiry, seconds */
  exp: number;
}

const encoder = new TextEncoder();

/**
 * Development fallback used when no `TOKEN_SECRET` is configured.
 *
 * It is a fixed, clearly-labelled constant on purpose: lcc-chat must run with
 * zero configuration, and a secret that changed on every Worker restart would
 * silently sign everybody out on each deploy. Set a real secret with
 * `wrangler secret put TOKEN_SECRET` before exposing lcc-chat to the internet.
 */
const DEV_SECRET = "lcc-chat-development-secret-not-for-production";

let warnedAboutSecret = false;

export function authSecret(env: Env): string {
  const secret = env.TOKEN_SECRET?.trim();
  if (secret && secret.length >= 16) return secret;

  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn(
      "[lcc-chat] TOKEN_SECRET is not set — using the built-in development secret. Sessions survive " +
        "restarts, but anyone can forge tokens: run `wrangler secret put TOKEN_SECRET` before " +
        "deploying lcc-chat publicly.",
    );
  }
  return DEV_SECRET;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(authSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign a session token for `userId`. */
export async function signToken(env: Env, userId: string, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const claims: TokenClaims = {
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS,
  };
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), encoder.encode(payload));
  return `${TOKEN_VERSION}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verify a session token. Throws `ApiError` when it is missing, forged or expired. */
export async function verifyToken(env: Env, token: string, now = Date.now()): Promise<TokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) throw ApiError.unauthorized("Malformed session token.");

  const [, payload, signature] = parts as [string, string, string];
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(env),
    fromBase64Url(signature),
    encoder.encode(payload),
  );
  if (!valid) throw ApiError.unauthorized("Invalid session token signature.");

  let claims: TokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as TokenClaims;
  } catch {
    throw ApiError.unauthorized("Malformed session token.");
  }
  if (typeof claims.sub !== "string" || claims.sub.length < 4) throw ApiError.unauthorized("Malformed session token.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now) {
    throw new ApiError(401, "TOKEN_EXPIRED", "Your session expired. Pick a name to start a new one.");
  }
  return claims;
}

/** Extract the bearer token from an `Authorization` header. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Authenticate a REST request and return the caller's user id. */
export async function requireUserId(request: Request, env: Env): Promise<string> {
  const token = bearerToken(request);
  if (!token) throw ApiError.unauthorized();
  const claims = await verifyToken(env, token);
  return claims.sub;
}

/**
 * Authenticate an upgrade request destined for a Durable Object.
 * The DO re-verifies the token itself, so nothing here is trusted blindly.
 */
export async function requireUpgradeUserId(request: Request, env: Env): Promise<string> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? bearerToken(request);
  if (!token) throw ApiError.unauthorized("Missing session token.");
  const claims = await verifyToken(env, token);
  return claims.sub;
}