import { DurableObject } from "cloudflare:workers";
import type { Env, WireMessage } from "../lib/types";
import { ApiError, errorBody, jsonResponse } from "../lib/errors";
import { bearerToken, verifyToken } from "../lib/auth";
import { hit } from "../lib/rate-limit";
import { presenceStub } from "./shared";

interface SocketState {
  userId: string;
  /** Set while the socket is closing so presence counts ignore it. */
  detaching?: boolean;
}

const CONNECT_LIMIT = 20;
/** How often a tab's ping is forwarded to the presence registry. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * One Durable Object instance per user: the "notification hub".
 *
 * The browser keeps a single socket here for the whole app, so lcc-chat can
 * deliver messages, presence and call signals for conversations that are not
 * currently on screen (unread badges, desktop notifications) without holding a
 * socket open in every room.
 */
export class UserSession extends DurableObject<Env> {
  /** The Durable Object name is the user id. */
  private get userId(): string {
    return this.ctx.id.name ?? "";
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      switch (path) {
        case "/ws":
          return await this.handleWebSocket(request, url);
        case "/notify":
          return await this.handleNotify(request);
        case "/room-opened":
          return jsonResponse({ ok: true, sockets: this.ctx.getWebSockets().length });
        default:
          throw ApiError.notFound(`Unknown session route: ${path}`);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return jsonResponse(errorBody(error.code, error.message, error.details), { status: error.status });
      }
      console.error("[lcc-chat] session request failed", error);
      return jsonResponse(errorBody("INTERNAL_ERROR", "Session request failed."), { status: 500 });
    }
  }

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get("token") ?? bearerToken(request);
    if (!token) throw ApiError.unauthorized("Missing session token.");

    const claims = await verifyToken(this.env, token);
    const userId = claims.sub;
    // The instance is named after the user id: never accept someone else's token.
    if (userId !== this.userId) throw ApiError.forbidden("This session belongs to another user.");

    if (hit(`session:${userId}`, CONNECT_LIMIT, 30_000)) {
      throw ApiError.rateLimited("Too many session connections. Reload the page in a moment.");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({ userId } satisfies SocketState);
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);
    server.send(JSON.stringify({ type: "ready", userId, serverTime: new Date().toISOString() }));

    await presenceStub(this.env)
      .fetch("https://presence.internal/join", {
        method: "POST",
        body: JSON.stringify({ userId, conversationId: null }),
      })
      .catch((error: unknown) => console.warn("[lcc-chat] presence join failed", error));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Fan an event out to every tab this user has open. */
  private async handleNotify(request: Request): Promise<Response> {
    const payload = (await request.json()) as { conversationId?: string; event: WireMessage };
    if (!payload?.event || typeof payload.event.type !== "string") throw ApiError.badRequest("Malformed event.");

    const body = JSON.stringify(payload.event);
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(body);
        delivered += 1;
      } catch {
        /* socket is closing */
      }
    }
    return jsonResponse({ ok: true, delivered });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    if (parsed.type !== "ping") return;

    ws.send(JSON.stringify({ type: "pong", serverTime: new Date().toISOString() }));

    // Forward a throttled liveness ping so the presence registry can expire
    // tabs that vanished without a clean close event.
    const state = (ws.deserializeAttachment() ?? {}) as Partial<SocketState>;
    const userId = state.userId;
    if (!userId) return;
    const last = this.lastHeartbeat.get(userId) ?? 0;
    if (Date.now() - last < HEARTBEAT_INTERVAL_MS) return;
    this.lastHeartbeat.set(userId, Date.now());
    await presenceStub(this.env)
      .fetch("https://presence.internal/heartbeat", {
        method: "POST",
        body: JSON.stringify({ userId }),
      })
      .catch(() => undefined);
  }

  /** Per-user throttle for heartbeat forwarding (in-memory, best effort). */
  private readonly lastHeartbeat = new Map<string, number>();

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.detach(ws, code >= 1000 && code < 5000 ? code : 1000, reason.slice(0, 120));
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.warn("[lcc-chat] session socket error", error);
    await this.detach(ws, 1011, "error");
  }

  /** When the last tab closes, the user goes offline. */
  private async detach(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = (ws.deserializeAttachment() ?? {}) as Partial<SocketState>;
    if (!state.userId) return;

    // The closing socket is still listed by `getWebSockets()` while this
    // handler runs, so mark it first and ignore it when counting the rest.
    ws.serializeAttachment({ userId: state.userId, detaching: true } satisfies SocketState);

    const otherTabs = this.ctx.getWebSockets().filter((socket) => {
      const attachment = (socket.deserializeAttachment() ?? {}) as Partial<SocketState>;
      return attachment.userId === state.userId && !attachment.detaching;
    });
    if (otherTabs.length > 0) return;

    await presenceStub(this.env)
      .fetch("https://presence.internal/offline", {
        method: "POST",
        body: JSON.stringify({ userId: state.userId }),
      })
      .catch((error: unknown) => console.warn("[lcc-chat] presence offline failed", error));
  }
}