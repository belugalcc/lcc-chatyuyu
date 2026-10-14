import type { Conversation, Env, Message, User, WireMessage } from "../lib/types";
import { ApiError, jsonResponse } from "../lib/errors";
import { requireUserId } from "../lib/auth";
import { dmConversationId, groupTitle, newGroupId } from "../lib/ids";
import { addConversation, getConversationIds, getUser, getUsers } from "../lib/kv";
import { dmSchema, groupSchema, parseJsonBody, parseOrThrow, readReceiptSchema } from "../lib/validate";
import { hit } from "../lib/rate-limit";
import { notifySessions, roomStub } from "../durable-objects/shared";
import type { RoomSummary } from "../durable-objects/chat-room";

/**
 * Conversation REST surface.
 *
 * Everything here is a thin, validated wrapper around the per-conversation
 * Durable Object — authorization is enforced by the room itself, which refuses
 * to hand out summaries, history or sockets for non-participants.
 */

/** `GET /api/conversations` — the caller's conversation list. */
export async function handleListConversations(request: Request, env: Env): Promise<Response> {
  const userId = await requireUserId(request, env);
  const conversationIds = await getConversationIds(env, userId);
  if (conversationIds.length === 0) return jsonResponse({ conversations: [], users: [] });

  const results = await Promise.all(
    conversationIds.map((conversationId) =>
      roomStub(env, conversationId)
        .fetch(`https://room.internal/summary?userId=${encodeURIComponent(userId)}`)
        .then(async (response) => {
          if (!response.ok) return null;
          return (await response.json()) as RoomSummary;
        })
        .catch(() => null),
    ),
  );

  const conversations = results
    .filter((summary): summary is RoomSummary => summary !== null)
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));

  const participantIds = new Set<string>();
  for (const conversation of conversations) {
    for (const id of conversation.participantIds) participantIds.add(id);
  }
  const profiles = await getUsers(env, [...participantIds]);

  return jsonResponse({
    conversations: conversations.map((summary) => decorate(summary, profiles, userId)),
    users: profiles,
    serverTime: new Date().toISOString(),
  });
}

/** `GET /api/conversations/:id` — one conversation with its summary. */
export async function handleGetConversation(request: Request, env: Env, conversationId: string): Promise<Response> {
  const userId = await requireUserId(request, env);
  const summary = await fetchSummary(env, conversationId, userId);
  const profiles = await getUsers(env, summary.participantIds);
  return jsonResponse({ conversation: decorate(summary, profiles, userId) });
}

/** `GET /api/conversations/:id/messages` — paginated history. */
export async function handleMessages(request: Request, env: Env, conversationId: string): Promise<Response> {
  const userId = await requireUserId(request, env);
  await assertMember(env, conversationId, userId);

  const url = new URL(request.url);
  const limit = url.searchParams.get("limit") ?? "50";
  const before = url.searchParams.get("before");
  const query = new URLSearchParams({ limit });
  if (before) query.set("before", before);

  const response = await roomStub(env, conversationId).fetch(
    `https://room.internal/messages?${query.toString()}`,
  );
  if (!response.ok) throw ApiError.notFound("History unavailable.");
  const data = (await response.json()) as { messages: Message[]; hasMore: boolean; cursor: number | null };

  const profiles = await getUsers(
    env,
    data.messages.map((message) => message.senderId),
  );
  return jsonResponse({ ...data, users: profiles });
}

/** `POST /api/conversations/:id/read` — REST fallback for the WS event. */
export async function handleMarkRead(request: Request, env: Env, conversationId: string): Promise<Response> {
  const userId = await requireUserId(request, env);
  const body = (await parseJsonBody(request)) as unknown;
  const input = parseOrThrow(readReceiptSchema, body);

  const response = await roomStub(env, conversationId).fetch("https://room.internal/read", {
    method: "POST",
    headers: { "x-lcc-user": userId },
    body: JSON.stringify({ messageIds: input.messageIds }),
  });
  if (!response.ok) throw ApiError.forbidden();
  return jsonResponse(await response.json());
}

/** `POST /api/conversations/dm` — deterministic one-to-one thread. */
export async function handleCreateDm(request: Request, env: Env): Promise<Response> {
  const userId = await requireUserId(request, env);
  if (hit(`dm:${userId}`, 30, 60_000)) throw ApiError.rateLimited("Slow down — too many new chats.");

  const body = (await parseJsonBody(request)) as unknown;
  const input = parseOrThrow(dmSchema, body);
  if (input.userId === userId) throw ApiError.validation("You cannot start a chat with yourself.");

  const other = await getUser(env, input.userId);
  if (!other) throw ApiError.notFound("That person does not exist.");

  const conversationId = dmConversationId(userId, other.id);
  const participantIds = [userId, other.id].sort();

  await roomStub(env, conversationId).fetch("https://room.internal/init", {
    method: "POST",
    headers: { "x-lcc-conversation": conversationId },
    body: JSON.stringify({
      id: conversationId,
      type: "dm",
      title: "",
      participantIds,
      createdAt: new Date().toISOString(),
    }),
  });

  for (const id of participantIds) await addConversation(env, id, conversationId);

  const summary = await fetchSummary(env, conversationId, userId);
  const profiles = await getUsers(env, participantIds);
  await announceConversation(env, summary, profiles, userId, participantIds);

  return jsonResponse({ conversation: decorate(summary, profiles, userId) }, { status: 201 });
}

/** `POST /api/conversations/group` — new group chat. */
export async function handleCreateGroup(request: Request, env: Env): Promise<Response> {
  const userId = await requireUserId(request, env);
  if (hit(`group:${userId}`, 10, 60_000)) throw ApiError.rateLimited("Slow down — too many new groups.");

  const body = (await parseJsonBody(request)) as unknown;
  const input = parseOrThrow(groupSchema, body);

  const participantIds = [...new Set([userId, ...(input.participantIds ?? [])])];
  if (participantIds.length < 2) throw ApiError.validation("Add at least one other person.");

  const found = await getUsers(env, participantIds);
  if (found.length !== participantIds.length) {
    throw ApiError.validation("One of those people does not exist.", {
      unknown: participantIds.filter((id) => !found.some((user) => user.id === id)),
    });
  }

  const conversationId = newGroupId();
  const profiles = await getUsers(env, participantIds);
  const displayNames = Object.fromEntries(profiles.map((user) => [user.id, user.displayName]));
  const title = groupTitle(
    input.title ?? participantIds.slice(1).map((id) => displayNames[id] ?? "Someone").join(", ").slice(0, 48),
    participantIds,
  );

  await roomStub(env, conversationId).fetch("https://room.internal/init", {
    method: "POST",
    headers: { "x-lcc-conversation": conversationId },
    body: JSON.stringify({
      id: conversationId,
      type: "group",
      title,
      participantIds,
      createdAt: new Date().toISOString(),
    }),
  });

  for (const id of participantIds) await addConversation(env, id, conversationId);

  const summary = await fetchSummary(env, conversationId, userId);
  await announceConversation(env, summary, profiles, userId, participantIds);

  return jsonResponse({ conversation: decorate(summary, profiles, userId) }, { status: 201 });
}

/* -------------------------------------------------------------- helpers */

async function fetchSummary(env: Env, conversationId: string, userId: string): Promise<RoomSummary> {
  const response = await roomStub(env, conversationId).fetch(
    `https://room.internal/summary?userId=${encodeURIComponent(userId)}`,
  );
  if (response.status === 403) throw ApiError.forbidden();
  if (response.status === 404) throw ApiError.notFound("Conversation not found.");
  if (!response.ok) throw ApiError.internal("Could not read that conversation.");
  return (await response.json()) as RoomSummary;
}

/** Cheap membership probe used before touching history. */
async function assertMember(env: Env, conversationId: string, userId: string): Promise<void> {
  await fetchSummary(env, conversationId, userId);
}

/** Resolve display names and avatar for the UI. */
function decorate(summary: RoomSummary, profiles: User[], viewerId: string): Conversation {
  const byId = new Map(profiles.map((user) => [user.id, user]));
  const others = summary.participantIds.filter((id) => id !== viewerId);
  const participants = summary.participantIds.map((id) => byId.get(id)).filter((user): user is User => Boolean(user));

  const title =
    summary.type === "dm"
      ? (others.map((id) => byId.get(id)?.displayName).find(Boolean) ?? "Direct message")
      : summary.title || `Group (${summary.participantIds.length})`;

  const conversation: Conversation = {
    id: summary.id,
    type: summary.type,
    title,
    participantIds: summary.participantIds,
    createdAt: summary.createdAt,
    lastMessageAt: summary.lastMessageAt,
    unread: summary.unread,
    lastMessage: summary.lastMessage,
  };

  const avatars = participants.map((user) => user.avatarUrl).filter((value): value is string => Boolean(value));
  if (avatars[0]) conversation.avatarUrl = avatars[0];
  return conversation;
}

/**
 * Tell members (and the creator) that a conversation exists.
 *
 * Each viewer gets their own copy because DM titles are personalised — Bob
 * should see "Alice", not his own name.
 */
async function announceConversation(
  env: Env,
  summary: RoomSummary,
  profiles: User[],
  creatorId: string,
  participantIds: string[],
): Promise<void> {
  await Promise.all(
    participantIds.map(async (viewerId) => {
      const conversation = decorate({ ...summary, unread: 0 }, profiles, viewerId);
      const event: WireMessage = { type: "conversation.created", conversation };
      await notifySessions(env, summary.id, [viewerId], event);
    }),
  );
}