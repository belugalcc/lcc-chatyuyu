import type { Env, WireMessage } from "../lib/types";

/**
 * Small helpers shared by the three Durable Objects so fan-out logic lives in
 * one place.
 */

/** Stable stub for a conversation room. */
export function roomStub(env: Env, conversationId: string): DurableObjectStub {
  return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(conversationId));
}

/** Stable stub for a user's notification hub. */
export function sessionStub(env: Env, userId: string): DurableObjectStub {
  return env.USER_SESSION.get(env.USER_SESSION.idFromName(userId));
}

/** The single global presence registry. */
export function presenceStub(env: Env): DurableObjectStub {
  return env.PRESENCE.get(env.PRESENCE.idFromName("global"));
}

/** Push an event to each user's session hub, ignoring individual failures. */
export async function notifySessions(
  env: Env,
  conversationId: string,
  userIds: string[],
  event: WireMessage,
): Promise<void> {
  const targets = [...new Set(userIds)];
  if (targets.length === 0) return;
  const body = JSON.stringify({ conversationId, event });
  await Promise.all(
    targets.map((userId) =>
      sessionStub(env, userId)
        .fetch("https://session.internal/notify", { method: "POST", body })
        .catch(() => undefined),
    ),
  );
}

/** Push an event to a single user's session hub. */
export async function notifyUser(env: Env, userId: string, event: WireMessage): Promise<void> {
  await notifySessions(env, event.type === "presence.update" ? "presence" : "", [userId], event);
}

/** Assert the caller meant the conversation this instance owns. */
export function conversationIdOf(request: Request, fallback: string): string {
  const header = request.headers.get("x-lcc-conversation");
  return header && header.length <= 128 ? header : fallback;
}

/**
 * The acting user for internal (Worker -> Durable Object) requests. Set by the
 * Worker *after* verifying the bearer token, so request bodies cannot spoof it.
 */
export function userIdOf(request: Request): string {
  return request.headers.get("x-lcc-user") ?? "";
}