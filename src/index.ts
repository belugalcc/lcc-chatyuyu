import type { Env } from "./lib/types";
import { ApiError, errorBody, jsonResponse } from "./lib/errors";
import { bearerToken, verifyToken } from "./lib/auth";
import { ChatRoom } from "./durable-objects/chat-room";
import { Presence } from "./durable-objects/presence";
import { UserSession } from "./durable-objects/user-session";
import {
  handleCreateSession,
  handleMe,
  handleMediaConfig,
  handlePresence,
  handleSearchUsers,
  handleUpdateMe,
} from "./routes/session";
import {
  handleCreateDm,
  handleCreateGroup,
  handleGetConversation,
  handleListConversations,
  handleMarkRead,
  handleMessages,
} from "./routes/conversations";

export { ChatRoom, Presence, UserSession };

/**
 * lcc-chat — Cloudflare Worker entrypoint.
 *
 * The frontend is fully static and talks to this Worker over HTTP + WebSockets
 * only. Everything real-time lives in Durable Objects; everything slowly
 * changing lives in Workers KV.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
      const response = await route(request, env, url, path);
      return withCors(response);
    } catch (error) {
      if (error instanceof ApiError) {
        return withCors(jsonResponse(errorBody(error.code, error.message, error.details), { status: error.status }));
      }
      console.error("[lcc-chat] unhandled error", path, error);
      return withCors(jsonResponse(errorBody("INTERNAL_ERROR", "Unexpected server error."), { status: 500 }));
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  const method = request.method.toUpperCase();

  /* ------------------------------------------------------------ health */

  if (path === "/" || path === "/health") {
    return jsonResponse({ ok: true, service: "lcc-chat", serverTime: new Date().toISOString() });
  }

  /* ------------------------------------------- identity (no sign-up!) */

  if (path === "/api/session" && method === "POST") return handleCreateSession(request, env);
  if (path === "/api/me" && method === "GET") return handleMe(request, env);
  if (path === "/api/me" && method === "PATCH") return handleUpdateMe(request, env);
  if (path === "/api/users" && method === "GET") return handleSearchUsers(request, env);
  if (path === "/api/presence" && method === "GET") return handlePresence(request, env);
  if (path === "/api/media/config" && method === "GET") return handleMediaConfig(request, env);

  /* ---------------------------------------------------- conversations */

  if (path === "/api/conversations" && method === "GET") return handleListConversations(request, env);
  if (path === "/api/conversations/dm" && method === "POST") return handleCreateDm(request, env);
  if (path === "/api/conversations/group" && method === "POST") return handleCreateGroup(request, env);

  const conversationMatch = /^\/api\/conversations\/([^/]+)(\/messages|\/read)?$/.exec(path);
  if (conversationMatch) {
    const conversationId = decodeURIComponent(conversationMatch[1] as string);
    const suffix = conversationMatch[2];

    if (!suffix && method === "GET") return handleGetConversation(request, env, conversationId);
    if (suffix === "/messages" && method === "GET") return handleMessages(request, env, conversationId);
    if (suffix === "/read" && method === "POST") return handleMarkRead(request, env, conversationId);
  }

  /* ------------------------------------------------ websocket gateways */

  // Durable Objects own the sockets; the Worker only forwards after checking
  // the token, so an invalid token never reaches a Durable Object.
  if (path === "/ws/session" && method === "GET") return upgradeToSession(request, env, url);
  if (path === "/ws" && method === "GET") return upgradeToRoom(request, env, url);

  throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${path}.`);
}

/**
 * `/ws/session` — the per-user notification hub.
 *
 * The original request is forwarded verbatim so the `Upgrade: websocket`
 * header survives; the Durable Object re-verifies the token before accepting.
 */
async function upgradeToSession(request: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? bearerToken(request);
  if (!token) throw ApiError.unauthorized("Missing session token.");
  const claims = await verifyToken(env, token);

  const stub = env.USER_SESSION.get(env.USER_SESSION.idFromName(claims.sub));
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-lcc-user", claims.sub);
  return stub.fetch(new Request("https://session.internal/ws", { headers }));
}

/** `/ws?conversationId=…` — the per-conversation room socket. */
async function upgradeToRoom(request: Request, env: Env, url: URL): Promise<Response> {
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) throw ApiError.badRequest("conversationId is required.");
  if (conversationId.length > 128) throw ApiError.badRequest("conversationId is too long.");

  const token = url.searchParams.get("token") ?? bearerToken(request);
  if (!token) throw ApiError.unauthorized("Missing session token.");
  const claims = await verifyToken(env, token); // the room re-checks membership

  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(conversationId));
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-lcc-user", claims.sub);
  const target = new Request(
    `https://room.internal/ws?conversationId=${encodeURIComponent(conversationId)}`,
    { headers },
  );
  return stub.fetch(target);
}

/**
 * The client is static and may be served from any host, so CORS is open.
 * Authentication is a bearer token (never a cookie), which keeps wildcard
 * origins safe: a third-party page cannot silently use a visitor's session.
 *
 * WebSocket upgrades (status 101) are returned untouched apart from the
 * security headers, because a 101 response cannot be re-wrapped.
 */
function withCors(response: Response): Response {
  try {
    response.headers.set("access-control-allow-origin", "*");
    response.headers.set("access-control-allow-headers", "authorization, content-type");
    response.headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.headers.set("access-control-max-age", "86400");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("referrer-policy", "no-referrer");
  } catch {
    /* immutable headers on an upgrade response — nothing to do */
  }
  return response;
}