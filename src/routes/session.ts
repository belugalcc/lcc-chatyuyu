import type { Env, MediaConfig, SessionResponse, User } from "../lib/types";
import { ApiError, jsonResponse } from "../lib/errors";
import { requireUserId, signToken } from "../lib/auth";
import { newUserId } from "../lib/ids";
import { clampText, colorFor, sanitizeUrl, toHandle } from "../lib/sanitize";
import { createUser, getUser, putUser, saveHandle, searchUsers } from "../lib/kv";
import { createSessionSchema, parseJsonBody, parseOrThrow, updateProfileSchema } from "../lib/validate";
import { hit } from "../lib/rate-limit";

/**
 * Identity for lcc-chat. There is no sign-up form anywhere: the visitor picks a
 * display name and the Worker hands back a signed session token.
 */

/** `POST /api/session` — start a session (no sign-up). */
export async function handleCreateSession(request: Request, env: Env): Promise<Response> {
  const clientKey = ipHint(request);
  if (hit(`session:${clientKey}`, 20, 60_000)) {
    throw ApiError.rateLimited("Too many new sessions from this address. Try again in a minute.");
  }

  const body = (await parseJsonBody(request, 8 * 1024)) as unknown;
  const input = parseOrThrow(createSessionSchema, body);

  const user: User = {
    id: newUserId(),
    username: toHandle(input.displayName),
    displayName: clampText(input.displayName, 32),
    color: colorFor(input.displayName + Date.now()),
    createdAt: new Date().toISOString(),
  };
  const avatarUrl = sanitizeUrl(input.avatarUrl);
  if (avatarUrl) user.avatarUrl = avatarUrl;

  await createUser(env, user);
  await saveHandle(env, user);

  const token = await signToken(env, user.id);
  const payload: SessionResponse = { token, user };
  return jsonResponse(payload, { status: 201 });
}

/** `GET /api/me` — the caller's profile (derived from the token only). */
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const userId = await requireUserId(request, env);
  const user = await getUser(env, userId);
  if (!user) throw ApiError.unauthorized("Your profile is gone — start a new session.");
  return jsonResponse({ user });
}

/** `PATCH /api/me` — rename yourself / change avatar. */
export async function handleUpdateMe(request: Request, env: Env): Promise<Response> {
  const userId = await requireUserId(request, env);
  const user = await getUser(env, userId);
  if (!user) throw ApiError.unauthorized("Your profile is gone — start a new session.");

  const body = (await parseJsonBody(request, 8 * 1024)) as unknown;
  const input = parseOrThrow(updateProfileSchema, body);

  if (input.displayName) {
    user.displayName = clampText(input.displayName, 32);
    user.username = toHandle(user.displayName);
    user.color = colorFor(user.displayName);
    await saveHandle(env, user);
  }
  if (input.avatarUrl !== undefined) {
    const avatarUrl = sanitizeUrl(input.avatarUrl);
    if (avatarUrl) user.avatarUrl = avatarUrl;
    else delete user.avatarUrl;
  }

  await putUser(env, user);
  return jsonResponse({ user });
}

/** `GET /api/users?q=` — find people to talk to. */
export async function handleSearchUsers(request: Request, env: Env): Promise<Response> {
  const userId = await requireUserId(request, env);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").slice(0, 64);
  const users = await searchUsers(env, query, userId);
  return jsonResponse({ users });
}

/** `GET /api/presence` — who is online right now. */
export async function handlePresence(request: Request, env: Env): Promise<Response> {
  await requireUserId(request, env);
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
  const response = await stub.fetch("https://presence.internal/online");
  const data = (await response.json()) as { userIds: string[] };
  return jsonResponse({ userIds: data.userIds, serverTime: new Date().toISOString() });
}

/** `GET /api/media/config` — PeerJS signalling + ICE servers for this browser. */
export async function handleMediaConfig(request: Request, env: Env): Promise<Response> {
  await requireUserId(request, env);

  const stunUrls = (env.STUN_URLS ?? "stun:stun.cloudflare.com:3478")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  // TURN credentials stay in Worker secrets and are only ever served here,
  // after authentication — they are never compiled into /client.
  const iceServers: MediaConfig["iceServers"] = stunUrls.map((urls) => ({ urls }));
  const turnUrl = (env as { TURN_URL?: string }).TURN_URL;
  const turnUser = (env as { TURN_USERNAME?: string }).TURN_USERNAME;
  const turnCredential = (env as { TURN_CREDENTIAL?: string }).TURN_CREDENTIAL;
  if (turnUrl && turnUser && turnCredential) {
    iceServers.push({ urls: turnUrl.split(",").map((value) => value.trim()), username: turnUser, credential: turnCredential });
  }

  const host = (env.PEER_HOST ?? "").trim();
  const config: MediaConfig = {
    peer: {
      host: host.length > 0 ? host : null,
      port: env.PEER_PORT ? Number.parseInt(env.PEER_PORT, 10) || 443 : 443,
      path: env.PEER_PATH || "/",
      secure: (env.PEER_SECURE ?? "true") !== "false",
      debug: 1,
    },
    iceServers,
    serverTime: new Date().toISOString(),
  };
  return jsonResponse(config);
}

/** Best-effort client identity for per-address rate limiting. */
function ipHint(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "anonymous"
  );
}