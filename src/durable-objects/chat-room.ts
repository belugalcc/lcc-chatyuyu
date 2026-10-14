import { DurableObject } from "cloudflare:workers";
import type { CallSignal, ClientEvent, Conversation, ConversationType, Env, Message, WireMessage } from "../lib/types";
import { ApiError, errorBody, jsonResponse } from "../lib/errors";
import { requireUpgradeUserId } from "../lib/auth";
import { conversationType, newMessageId } from "../lib/ids";
import { clampText, sanitizeText } from "../lib/sanitize";
import { hit } from "../lib/rate-limit";
import { conversationIdOf, notifySessions, presenceStub, sessionStub, userIdOf } from "./shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  sender_id  TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at  TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_seq_desc ON messages (seq DESC);
CREATE TABLE IF NOT EXISTS participants (
  user_id              TEXT PRIMARY KEY,
  joined_at            TEXT NOT NULL,
  last_read_at         TEXT,
  last_read_message_id TEXT,
  last_read_seq        INTEGER NOT NULL DEFAULT 0
);
`;

interface MessageRow {
  seq: number;
  id: string;
  sender_id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

/** Hibernation attachment: what a socket is, without keeping the DO awake. */
interface SocketState {
  userId: string;
  typing: boolean;
  inCall: CallSignal["media"];
  /** Set while the socket is closing so presence counts ignore it. */
  detaching?: boolean;
}

const TYPING_BURST_LIMIT = 6;
const TYPING_WINDOW_MS = 10_000;
const CONNECTION_ATTEMPT_LIMIT = 12;

export interface RoomSummary extends Conversation {
  lastReadAt?: string;
  lastReadMessageId?: string;
  callParticipants: Array<{ userId: string; media: CallSignal["media"] }>;
}

/**
 * One Durable Object instance per conversation.
 *
 * Owns the conversation's SQLite history, its live WebSocket fan-out, typing
 * indicators, read receipts and unread counts. It is the only source of truth
 * for message data; KV is never involved in live delivery.
 */
export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(SCHEMA);
    });
  }

  /** Live call roster. Ephemeral: clients re-announce after a reconnect. */
  private readonly callParticipants = new Map<string, CallSignal["media"]>();

  /** The Durable Object name is the conversation id. */
  private get roomId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  /* ------------------------------------------------------------ routing */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      switch (path) {
        case "/init":
          return await this.handleInit(request);
        case "/participants":
          return await this.handleAddParticipants(request);
        case "/messages":
          return this.handleMessages(url);
        case "/read":
          return await this.handleRead(request);
        case "/summary":
          return this.handleSummary(url);
        case "/ws":
          return this.handleWebSocket(request, url);
        case "/broadcast":
          return await this.handleBroadcast(request);
        default:
          throw ApiError.notFound(`Unknown room route: ${path}`);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return jsonResponse(errorBody(error.code, error.message, error.details), { status: error.status });
      }
      console.error("[lcc-chat] room request failed", error);
      return jsonResponse(errorBody("INTERNAL_ERROR", "Room request failed."), { status: 500 });
    }
  }

  /* ------------------------------------------------------------- routes */

  /** Create (or re-assert) conversation metadata. Idempotent. */
  private async handleInit(request: Request): Promise<Response> {
    const payload = (await request.json()) as {
      id?: string;
      type: ConversationType;
      title?: string;
      participantIds: string[];
      createdAt?: string;
    };
    const id = conversationIdOf(request, this.roomId);
    const now = new Date().toISOString();

    this.putMeta("id", id);
    this.putMeta("type", payload.type);
    if (!this.getMeta("title")) this.putMeta("title", clampText(payload.title ?? "Conversation", 60));
    if (!this.getMeta("createdAt")) this.putMeta("createdAt", payload.createdAt ?? now);

    for (const userId of payload.participantIds) this.addParticipant(userId, now);
    return jsonResponse({ ok: true, id, participants: this.participants() });
  }

  /** Add members to an existing group. Idempotent. */
  private async handleAddParticipants(request: Request): Promise<Response> {
    const payload = (await request.json()) as { participantIds: string[] };
    const now = new Date().toISOString();
    for (const userId of payload.participantIds) this.addParticipant(userId, now);
    return jsonResponse({ ok: true, participants: this.participants() });
  }

  private addParticipant(userId: string, now: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO participants (user_id, joined_at) VALUES (?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
      userId,
      now,
    );
  }

  /** Paginated history, oldest-first. `before` is a message seq cursor. */
  private handleMessages(url: URL): Response {
    const limit = clampNumber(url.searchParams.get("limit"), 1, 100, 50);
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw ? Number.parseInt(beforeRaw, 10) : null;

    const rows = (
      before !== null && Number.isFinite(before)
        ? this.ctx.storage.sql.exec(
            `SELECT seq, id, sender_id, content, created_at, edited_at, deleted_at
               FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?`,
            before,
            limit,
          )
        : this.ctx.storage.sql.exec(
            `SELECT seq, id, sender_id, content, created_at, edited_at, deleted_at
               FROM messages ORDER BY seq DESC LIMIT ?`,
            limit,
          )
    ).toArray() as unknown as MessageRow[];

    const ordered = rows.reverse();
    const messages = ordered.map((row) => toMessage(row, this.roomId));
    return jsonResponse({
      messages,
      hasMore: rows.length === limit,
      cursor: rows[0]?.seq ?? null,
    });
  }

  /** Mark messages read (HTTP fallback for the `message.read` WS event). */
  private async handleRead(request: Request): Promise<Response> {
    const payload = (await request.json()) as { messageIds: string[] };
    // The acting user comes from an internal header set by the Worker after it
    // verified the bearer token — never from the payload.
    const userId = userIdOf(request);
    this.assertMember(userId);
    return jsonResponse(await this.applyReadReceipt(userId, Array.isArray(payload.messageIds) ? payload.messageIds : []));
  }

  /**
   * Everything `/api/conversations` needs for one conversation — metadata,
   * participants, last message and the caller's unread count — in a single
   * Durable Object round-trip.
   */
  private handleSummary(url: URL): Response {
    const userId = url.searchParams.get("userId") ?? "";
    const conversation = this.readConversationMeta();
    if (!conversation) throw ApiError.notFound("Conversation not found.");
    if (userId && !conversation.participantIds.includes(userId)) throw ApiError.forbidden();

    const lastMessageRow = this.ctx.storage.sql.exec(
      `SELECT seq, id, sender_id, content, created_at, edited_at, deleted_at
         FROM messages ORDER BY seq DESC LIMIT 1`,
    ).toArray()[0] as unknown as MessageRow | undefined;

    const readRow = userId
      ? (this.ctx.storage.sql.exec(
          `SELECT last_read_at, last_read_message_id, last_read_seq
             FROM participants WHERE user_id = ?`,
          userId,
        ).toArray()[0] as
          | { last_read_at: string | null; last_read_message_id: string | null; last_read_seq: number }
          | undefined)
      : undefined;

    const unread =
      userId > ""
        ? (
            this.ctx.storage.sql.exec(
              `SELECT COUNT(*) AS count FROM messages
                WHERE seq > ? AND sender_id != ? AND deleted_at IS NULL`,
              readRow?.last_read_seq ?? 0,
              userId,
            ).toArray()[0] as unknown as { count: number }
        ).count
        : 0;

    const summary: RoomSummary = {
      ...conversation,
      lastMessage: lastMessageRow ? toMessage(lastMessageRow, conversation.id) : null,
      unread,
      lastReadAt: readRow?.last_read_at ?? undefined,
      lastReadMessageId: readRow?.last_read_message_id ?? undefined,
      callParticipants: [...this.callParticipants.entries()].map(([user, media]) => ({ userId: user, media })),
    };

    return jsonResponse(summary);
  }

  /**
   * Broadcast an event into this room.
   *
   * Used by the Presence DO: because the room owns its participant list it can
   * also forward the event to every participant's session hub, which is how
   * sidebar presence dots update when a room is not on screen.
   */
  private async handleBroadcast(request: Request): Promise<Response> {
    const payload = (await request.json()) as {
      event: WireMessage;
      targetUserId?: string;
      exceptUserId?: string;
      notifySessions?: boolean;
    };
    this.broadcast(payload.event, payload);

    if (payload.notifySessions) {
      const eventUser = (payload.event as { userId?: string }).userId;
      const recipients = this.participants().filter((id) => id !== eventUser);
      await notifySessions(this.env, this.roomId, recipients, payload.event);
    }
    return jsonResponse({ ok: true });
  }

  /* ---------------------------------------------------------- websocket */

  /** Accept a room socket after verifying both the token and the membership. */
  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    const userId = await requireUpgradeUserId(request, this.env);
    const requested = url.searchParams.get("conversationId");
    if (requested && requested !== this.roomId) throw ApiError.forbidden();
    this.assertMember(userId);

    if (hit(`ws:${this.roomId}:${userId}`, CONNECTION_ATTEMPT_LIMIT, 30_000)) {
      throw ApiError.rateLimited("Too many connection attempts. Wait a moment and retry.");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({ userId, typing: false, inCall: null } satisfies SocketState);
    this.ctx.acceptWebSocket(server, [`user:${userId}`, `conversation:${this.roomId}`]);

    const conversationId = this.roomId;
    server.send(
      JSON.stringify({ type: "ready", conversationId, userId, serverTime: new Date().toISOString() }),
    );
    server.send(JSON.stringify({ type: "call.participants", conversationId, participants: [...this.callParticipants.keys()] }));

    this.broadcast({ type: "presence.update", userId, online: true });
    this.broadcastCallParticipants();

    const presence = presenceStub(this.env);
    this.ctx.waitUntil(
      presence
        .fetch("https://presence.internal/join", {
          method: "POST",
          body: JSON.stringify({ userId, conversationId }),
        })
        .then(() =>
          sessionStub(this.env, userId).fetch("https://session.internal/room-opened", {
            method: "POST",
            body: JSON.stringify({ conversationId }),
          }),
        )
        .catch((error: unknown) => console.warn("[lcc-chat] presence join failed", error)),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const state = (ws.deserializeAttachment() ?? {}) as Partial<SocketState>;
    const userId = state.userId;
    if (!userId) {
      ws.close(1008, "missing state");
      return;
    }
    if (typeof raw !== "string") {
      ws.send(JSON.stringify({ type: "error", code: "BAD_REQUEST", message: "Binary frames are not supported." }));
      return;
    }

    let event: ClientEvent;
    try {
      event = JSON.parse(raw) as ClientEvent;
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "BAD_REQUEST", message: "Expected a JSON frame." }));
      return;
    }

    try {
      switch (event.type) {
        case "message.send":
          await this.handleSend(ws, userId, event.content, event.clientMessageId);
          return;
        case "message.edit":
          await this.handleEdit(userId, event.messageId, event.content);
          return;
        case "message.delete":
          await this.handleDelete(userId, event.messageId);
          return;
        case "typing.start":
          this.setTyping(ws, userId, true, state);
          return;
        case "typing.stop":
          this.setTyping(ws, userId, false, state);
          return;
        case "message.read":
          await this.applyReadReceipt(userId, Array.isArray(event.messageIds) ? event.messageIds : []);
          return;
        case "call.signal":
          this.handleCallSignal(ws, userId, event.to, event.payload);
          return;
        case "ping":
          ws.send(JSON.stringify({ type: "pong", serverTime: new Date().toISOString() }));
          return;
        default:
          ws.send(
            JSON.stringify({
              type: "error",
              code: "BAD_REQUEST",
              message: `Unknown event: ${(event as { type: string }).type}`,
            }),
          );
      }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : ApiError.internal();
      if (!(error instanceof ApiError)) console.error("[lcc-chat] ws handler failed", error);
      ws.send(JSON.stringify({ type: "error", code: apiError.code, message: apiError.message }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.detach(ws, code >= 1000 && code < 5000 ? code : 1000, reason.slice(0, 120));
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.warn("[lcc-chat] room socket error", error);
    await this.detach(ws, 1011, "error");
  }

  /** Stop typing, leave the call and drop presence when a socket goes away. */
  private async detach(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = (ws.deserializeAttachment() ?? {}) as Partial<SocketState>;
    const userId = state.userId;
    if (!userId) return;

    // The closing socket is still listed by `getWebSockets()` while this
    // handler runs, so mark it first and ignore it when counting the rest.
    ws.serializeAttachment({ userId, typing: false, inCall: state.inCall ?? null, detaching: true } satisfies SocketState);

    if (state.typing) {
      this.broadcast({ type: "typing.update", conversationId: this.roomId, userId, typing: false });
    }
    if (state.inCall) {
      this.callParticipants.delete(userId);
      this.broadcastCallParticipants();
    }

    if (this.liveSocketsFor(userId).length > 0) return;

    this.broadcast({ type: "presence.update", userId, online: false });
    const presence = presenceStub(this.env);
    await presence
      .fetch("https://presence.internal/room-closed", {
        method: "POST",
        body: JSON.stringify({ userId, conversationId: this.roomId }),
      })
      .catch((error: unknown) => console.warn("[lcc-chat] presence leave failed", error));
  }

  /** Sockets for a user that are not on their way out. */
  private liveSocketsFor(userId: string): WebSocket[] {
    return this.ctx.getWebSockets(`user:${userId}`).filter((socket) => {
      const attachment = (socket.deserializeAttachment() ?? {}) as Partial<SocketState>;
      return attachment.userId === userId && !attachment.detaching;
    });
  }

  /* -------------------------------------------------------- message ops */

  private async handleSend(
    ws: WebSocket,
    userId: string,
    content: string,
    clientMessageId?: string,
  ): Promise<void> {
    const perMinute = Number.parseInt(this.env.MESSAGES_PER_MINUTE ?? "60", 10) || 60;
    if (hit(`msg:${this.roomId}:${userId}`, perMinute, 60_000)) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "RATE_LIMITED",
          message: `You are sending messages too quickly (limit ${perMinute}/min).`,
        }),
      );
      return;
    }

    const max = Number.parseInt(this.env.MAX_MESSAGE_LENGTH ?? "4000", 10) || 4000;
    const text = sanitizeText(content).slice(0, max);
    if (text.length === 0) {
      ws.send(JSON.stringify({ type: "error", code: "VALIDATION_FAILED", message: "Message cannot be empty." }));
      return;
    }

    const message = this.insertMessage(userId, text);
    this.broadcast({ type: "message.new", message, clientMessageId });

    // Users who are not looking at this room hear about it from their hub.
    await notifySessions(this.env, this.roomId, this.participants().filter((id) => id !== userId), {
      type: "message.new",
      message,
    });

    // The author has, by definition, read their own message.
    await this.applyReadReceipt(userId, [message.id], { broadcast: false });
  }

  private async handleEdit(userId: string, messageId: string, content: string): Promise<void> {
    const max = Number.parseInt(this.env.MAX_MESSAGE_LENGTH ?? "4000", 10) || 4000;
    const row = this.getMessageRow(messageId);
    if (!row) throw ApiError.notFound("Message not found.");
    if (row.sender_id !== userId) throw ApiError.forbidden("You can only edit your own messages.");
    if (row.deleted_at) throw ApiError.badRequest("That message was deleted.");

    const text = sanitizeText(content).slice(0, max);
    if (text.length === 0) throw ApiError.validation("Message cannot be empty.");

    const editedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(`UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`, text, editedAt, messageId);

    const message = toMessage({ ...row, content: text, edited_at: editedAt }, this.roomId);
    this.broadcast({ type: "message.updated", message });
    await notifySessions(this.env, this.roomId, this.participants().filter((id) => id !== userId), {
      type: "message.updated",
      message,
    });
  }

  private async handleDelete(userId: string, messageId: string): Promise<void> {
    const row = this.getMessageRow(messageId);
    if (!row) throw ApiError.notFound("Message not found.");
    if (row.sender_id !== userId) throw ApiError.forbidden("You can only delete your own messages.");

    const deletedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(`UPDATE messages SET deleted_at = ?, content = '' WHERE id = ?`, deletedAt, messageId);

    const event: WireMessage = {
      type: "message.deleted",
      conversationId: this.roomId,
      messageId,
      senderId: userId,
    };
    this.broadcast(event);
    await notifySessions(this.env, this.roomId, this.participants().filter((id) => id !== userId), event);
  }

  private insertMessage(senderId: string, content: string): Message {
    const id = newMessageId();
    const createdAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (id, sender_id, content, created_at) VALUES (?, ?, ?, ?)`,
      id,
      senderId,
      content,
      createdAt,
    );
    this.putMeta("lastMessageAt", createdAt);
    return { id, conversationId: this.roomId, senderId, content, createdAt };
  }

  private getMessageRow(messageId: string): MessageRow | undefined {
    return this.ctx.storage.sql.exec(
      `SELECT seq, id, sender_id, content, created_at, edited_at, deleted_at FROM messages WHERE id = ?`,
      messageId,
    ).toArray()[0] as unknown as MessageRow | undefined;
  }

  /* ----------------------------------------------------------- presence */

  private setTyping(ws: WebSocket, userId: string, typing: boolean, state: Partial<SocketState>): void {
    if (typing && hit(`typing:${this.roomId}:${userId}`, TYPING_BURST_LIMIT, TYPING_WINDOW_MS)) return;
    ws.serializeAttachment({ userId, typing, inCall: state.inCall ?? null } satisfies SocketState);
    this.broadcast({ type: "typing.update", conversationId: this.roomId, userId, typing });
  }

  /** Relay an SDP/ICE payload to one participant, and track the call roster. */
  private handleCallSignal(ws: WebSocket, userId: string, to: string, payload: CallSignal): void {
    const members = this.participants();
    if (!members.includes(to)) throw ApiError.forbidden("You can only signal other participants.");

    const signal: CallSignal = payload ?? { kind: "state" };

    if (signal.kind === "state" && signal.media) {
      this.callParticipants.set(userId, signal.media);
      ws.serializeAttachment({ userId, typing: false, inCall: signal.media } satisfies SocketState);
      this.broadcastCallParticipants();
    }
    if (signal.kind === "bye") {
      this.callParticipants.delete(userId);
      ws.serializeAttachment({ userId, typing: false, inCall: null } satisfies SocketState);
      this.broadcastCallParticipants();
    }

    const event: WireMessage = { type: "call.signal", from: userId, payload: signal };
    const targets = this.ctx.getWebSockets(`user:${to}`);
    for (const target of targets) {
      try {
        target.send(JSON.stringify(event));
      } catch {
        /* socket is closing */
      }
    }
    // Nobody has the room open on that side — fall back to their session hub.
    if (targets.length === 0) {
      void notifySessions(this.env, this.roomId, [to], event);
    }
  }

  private broadcastCallParticipants(): void {
    const event: WireMessage = {
      type: "call.participants",
      conversationId: this.roomId,
      participants: [...this.callParticipants.keys()],
    };
    this.broadcast(event);
    void notifySessions(this.env, this.roomId, this.participants(), event);
  }

  /* ------------------------------------------------------ read receipts */

  private async applyReadReceipt(
    userId: string,
    messageIds: string[],
    options: { broadcast?: boolean } = {},
  ): Promise<{ readAt: string; messageIds: string[] }> {
    const ids = [...new Set(messageIds.filter((id) => typeof id === "string" && id.length <= 64))];
    const readAt = new Date().toISOString();
    if (ids.length === 0) return { readAt, messageIds: [] };

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.ctx.storage.sql.exec(
      `SELECT seq, id FROM messages WHERE id IN (${placeholders})`,
      ...ids,
    ).toArray() as unknown as Array<{ seq: number; id: string }>;
    if (rows.length === 0) return { readAt, messageIds: [] };

    const newest = rows.reduce((best, row) => (row.seq > best.seq ? row : best), rows[0] as { seq: number; id: string });
    this.ctx.storage.sql.exec(
      `UPDATE participants
          SET last_read_at = ?,
              last_read_seq = MAX(last_read_seq, ?),
              last_read_message_id = ?
        WHERE user_id = ?`,
      readAt,
      newest.seq,
      newest.id,
      userId,
    );

    const confirmed = rows.map((row) => row.id);
    if (options.broadcast !== false) {
      const event: WireMessage = {
        type: "message.read",
        conversationId: this.roomId,
        userId,
        messageIds: confirmed,
        readAt,
      };
      this.broadcast(event);
      await notifySessions(this.env, this.roomId, this.participants().filter((id) => id !== userId), event);
    }
    return { readAt, messageIds: confirmed };
  }

  /* ------------------------------------------------------------ helpers */

  private putMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0] as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private participants(): string[] {
    return (
      this.ctx.storage.sql.exec(`SELECT user_id FROM participants ORDER BY joined_at`).toArray() as unknown as Array<{
        user_id: string;
      }>
    ).map((row) => row.user_id);
  }

  private readConversationMeta(): Conversation | null {
    if (this.getMeta("id") === null && this.getMeta("type") === null) return null;
    const id = this.getMeta("id") ?? this.roomId;
    return {
      id,
      type: conversationType(id) ?? "group",
      title: this.getMeta("title") ?? "Conversation",
      participantIds: this.participants(),
      createdAt: this.getMeta("createdAt") ?? new Date().toISOString(),
      lastMessageAt: this.getMeta("lastMessageAt") ?? undefined,
    };
  }

  private assertMember(userId: string): void {
    if (!this.participants().includes(userId)) throw ApiError.forbidden();
  }

  /** Fan an event out to the room's sockets. */
  private broadcast(event: WireMessage, options: { exceptUserId?: string; targetUserId?: string } = {}): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      const state = (ws.deserializeAttachment() ?? {}) as Partial<SocketState>;
      if (options.exceptUserId && state.userId === options.exceptUserId) continue;
      if (options.targetUserId && state.userId !== options.targetUserId) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore sockets that are closing */
      }
    }
  }
}

/* ---------------------------------------------------------------- utils */

function toMessage(row: MessageRow, conversationId: string): Message {
  const message: Message = {
    id: row.id,
    conversationId,
    senderId: row.sender_id,
    content: row.content,
    createdAt: row.created_at,
  };
  if (row.edited_at) message.editedAt = row.edited_at;
  if (row.deleted_at) message.deletedAt = row.deleted_at;
  return message;
}

function clampNumber(raw: string | null, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}