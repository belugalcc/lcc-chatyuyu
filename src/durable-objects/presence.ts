import { DurableObject } from "cloudflare:workers";
import type { Env, WireMessage } from "../lib/types";
import { ApiError, errorBody, jsonResponse } from "../lib/errors";
import { getConversationIds } from "../lib/kv";
import { roomStub } from "./shared";

interface OnlineRecord {
  /** Connection keys: `session`, `room:<conversationId>`. */
  connections: string[];
  since: string;
  lastSeen: number;
}

const KEY_PREFIX = "online:";
const SESSION_KEY = "session";
/** A user with no heartbeat for this long is treated as gone (tab crashed, network dropped). */
const STALE_MS = 75_000;
/** How often the sweep runs while somebody is online. */
const SWEEP_MS = 30_000;

/**
 * A single Durable Object that answers "who is online?".
 *
 * A user counts as online while they hold at least one socket — their session
 * hub or any open room — and while they keep sending heartbeats. State lives in
 * Durable Object storage, never in Workers KV, which is eventually consistent.
 */
export class Presence extends DurableObject<Env> {
  /* ---------------------------------------------------------- routing */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      switch (path) {
        case "/join":
          return await this.join((await request.json()) as { userId: string; conversationId?: string | null });
        case "/heartbeat":
          return await this.heartbeat((await request.json()) as { userId: string });
        case "/room-closed":
          return await this.leave((await request.json()) as { userId: string; conversationId: string }, "room");
        case "/offline":
          return await this.leave((await request.json()) as { userId: string }, "session");
        case "/online":
          return jsonResponse({ userIds: await this.onlineUsers() });
        default:
          throw ApiError.notFound(`Unknown presence route: ${path}`);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return jsonResponse(errorBody(error.code, error.message, error.details), { status: error.status });
      }
      console.error("[lcc-chat] presence request failed", error);
      return jsonResponse(errorBody("INTERNAL_ERROR", "Presence request failed."), { status: 500 });
    }
  }

  /** A socket appeared: record it and announce the transition if it is new. */
  private async join(payload: { userId: string; conversationId?: string | null }): Promise<Response> {
    const userId = payload.userId;
    if (!userId) throw ApiError.badRequest("userId is required.");

    const connection = payload.conversationId ? `room:${payload.conversationId}` : SESSION_KEY;
    const record = await this.read(userId);
    const wasOnline = record.connections.length > 0;

    if (!record.connections.includes(connection)) record.connections.push(connection);
    record.lastSeen = Date.now();
    if (!wasOnline) record.since = new Date(record.lastSeen).toISOString();
    await this.write(userId, record);
    this.ensureAlarm();

    if (!wasOnline) await this.announce(userId, true);
    return jsonResponse({ ok: true, changed: !wasOnline });
  }

  /** Cheap liveness ping from an open tab. */
  private async heartbeat(payload: { userId: string }): Promise<Response> {
    const record = await this.read(payload.userId);
    if (record.connections.length === 0) return jsonResponse({ ok: true, online: false });
    record.lastSeen = Date.now();
    await this.write(payload.userId, record);
    return jsonResponse({ ok: true, online: true });
  }

  /** A socket went away; announce when the last one is gone. */
  private async leave(
    payload: { userId: string; conversationId?: string },
    kind: "room" | "session",
  ): Promise<Response> {
    const userId = payload.userId;
    if (!userId) throw ApiError.badRequest("userId is required.");

    const connection = kind === "session" ? SESSION_KEY : `room:${payload.conversationId}`;
    const record = await this.read(userId);
    const next = record.connections.filter((entry) => entry !== connection);
    if (next.length === record.connections.length) return jsonResponse({ ok: true, changed: false });

    record.connections = next;
    record.lastSeen = Date.now();
    await this.write(userId, record);

    if (next.length === 0) {
      this.ensureAlarm();
      await this.announce(userId, false);
    }
    return jsonResponse({ ok: true, changed: next.length === 0 });
  }

  /**
   * Drop users whose sockets vanished without a close event (crashed tab,
   * killed process) so presence cannot get stuck on "online".
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const records = await this.ctx.storage.list<OnlineRecord>({ prefix: KEY_PREFIX });
    const stale: string[] = [];

    for (const [key, record] of records) {
      if (!record || record.connections.length === 0 || now - (record.lastSeen ?? 0) > STALE_MS) {
        stale.push(key.slice(KEY_PREFIX.length));
      }
    }

    for (const userId of stale) {
      await this.ctx.storage.delete(KEY_PREFIX + userId);
      await this.announce(userId, false);
    }

    const remaining = await this.ctx.storage.list({ prefix: KEY_PREFIX, limit: 1 });
    if (remaining.size > 0) await this.ctx.storage.setAlarm(now + SWEEP_MS);
    else await this.ctx.storage.deleteAlarm();
  }

  /**
   * Push `presence.update` to every conversation the user takes part in. Each
   * room knows its participants, so it fans the event out to both its sockets
   * and those participants' session hubs.
   */
  private async announce(userId: string, online: boolean): Promise<void> {
    const event: WireMessage = { type: "presence.update", userId, online };
    const conversationIds = await getConversationIds(this.env, userId);
    await Promise.all(
      conversationIds.map((conversationId) =>
        roomStub(this.env, conversationId)
          .fetch("https://room.internal/broadcast", {
            method: "POST",
            body: JSON.stringify({ event, exceptUserId: userId, notifySessions: true }),
          })
          .catch((error: unknown) => console.warn("[lcc-chat] presence announce failed", error)),
      ),
    );
  }

  /** Sweep while anyone is online; idle rooms cost nothing. */
  private ensureAlarm(): void {
    void this.ctx.storage.setAlarm(Date.now() + SWEEP_MS).catch(() => undefined);
  }

  /* ---------------------------------------------------------- storage */

  private async read(userId: string): Promise<OnlineRecord> {
    const record = await this.ctx.storage.get<OnlineRecord>(KEY_PREFIX + userId);
    return record ?? { connections: [], since: new Date().toISOString(), lastSeen: 0 };
  }

  private async write(userId: string, record: OnlineRecord): Promise<void> {
    if (record.connections.length === 0) await this.ctx.storage.delete(KEY_PREFIX + userId);
    else await this.ctx.storage.put(KEY_PREFIX + userId, record);
  }

  private async onlineUsers(): Promise<string[]> {
    const records = await this.ctx.storage.list<OnlineRecord>({ prefix: KEY_PREFIX });
    const userIds: string[] = [];
    for (const [key, record] of records) {
      if (record && record.connections.length > 0) userIds.push(key.slice(KEY_PREFIX.length));
    }
    return userIds;
  }
}