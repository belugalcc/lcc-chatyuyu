import type { Env, User } from "./types";

/**
 * Workers KV layout.
 *
 * KV holds slowly changing / read-heavy data only: profiles, per-user
 * conversation indexes, the searchable user directory and cached media config.
 * Live messages, presence, typing and read receipts live in Durable Objects.
 *
 *   user:<userId>            -> User
 *   user:<userId>:conversations -> string[]  (conversation ids)
 *   handle:<username>        -> userId        (lookup by @handle)
 *   directory                -> string[]      (all user ids, capped)
 */

export const KV_PREFIX = {
  user: "user:",
  conversations: "conversations:",
  handle: "handle:",
  directory: "directory",
  mediaConfig: "config:media",
} as const;

const DIRECTORY_LIMIT = 5000;
/** How many recent profiles a single search scans (batched KV reads). */
const SEARCH_WINDOW = 300;

export async function getUser(env: Env, userId: string): Promise<User | null> {
  return env.PROFILES.get<User>(userKey(userId), "json");
}

/** Create a brand new profile (also seeds an empty conversation index). */
export async function createUser(env: Env, user: User): Promise<void> {
  await env.PROFILES.put(userKey(user.id), JSON.stringify(user));
  await env.PROFILES.put(`${KV_PREFIX.conversations}${user.id}`, JSON.stringify([]));
}

/** Update an existing profile. Never touches the conversation index. */
export async function putUser(env: Env, user: User): Promise<void> {
  await env.PROFILES.put(userKey(user.id), JSON.stringify(user));
}

/** Workers KV rejects bulk reads of more than 100 keys, so batch them. */
const KV_BULK_LIMIT = 100;

/** Batch-load profiles, tolerating ids that no longer exist. */
export async function getUsers(env: Env, userIds: string[]): Promise<User[]> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];

  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += KV_BULK_LIMIT) {
    batches.push(unique.slice(index, index + KV_BULK_LIMIT));
  }

  const results = await Promise.all(
    batches.map((batch) => env.PROFILES.get<User>(batch.map(userKey), "json").catch(() => null)),
  );

  const users: User[] = [];
  for (const found of results) {
    if (!found) continue;
    for (const value of found.values()) {
      if (!value) continue;
      if (Array.isArray(value)) users.push(...value.filter((user): user is User => Boolean(user)));
      else users.push(value);
    }
  }
  return users;
}

function userKey(userId: string): string {
  return `${KV_PREFIX.user}${userId}`;
}

/** Persist the `@handle -> userId` mapping so people can be found by name. */
export async function saveHandle(env: Env, user: User): Promise<void> {
  await env.PROFILES.put(`${KV_PREFIX.handle}${user.username}`, user.id);
  await addToDirectory(env, user.id);
}

export async function findByHandle(env: Env, username: string): Promise<string | null> {
  return env.PROFILES.get<string>(`${KV_PREFIX.handle}${username.toLowerCase()}`);
}

/** Add a user id to the small searchable directory list. */
async function addToDirectory(env: Env, userId: string): Promise<void> {
  const list = (await env.PROFILES.get<string[]>(KV_PREFIX.directory, "json")) ?? [];
  if (list.includes(userId)) return;
  list.push(userId);
  if (list.length > DIRECTORY_LIMIT) list.splice(0, list.length - DIRECTORY_LIMIT);
  await env.PROFILES.put(KV_PREFIX.directory, JSON.stringify(list));
}

/**
 * KV cannot do substring queries, so search walks the capped directory and
 * filters in memory. Newest profiles first, so somebody who just joined
 * lcc-chat is always findable. Swap in D1 if lcc-chat outgrows this.
 */
export async function searchUsers(env: Env, query: string, excludeUserId: string): Promise<User[]> {
  const list = (await env.PROFILES.get<string[]>(KV_PREFIX.directory, "json")) ?? [];
  if (list.length === 0) return [];
  const needle = query.trim().toLowerCase();
  const candidates = list.slice(-SEARCH_WINDOW).reverse();
  const users = await getUsers(env, candidates);
  return users
    .filter((user) => user.id !== excludeUserId)
    .filter(
      (user) =>
        needle.length === 0 ||
        user.username.includes(needle) ||
        user.displayName.toLowerCase().includes(needle),
    )
    .slice(0, 25);
}

/* ------------------------------------------------------ conversation index */

export async function getConversationIds(env: Env, userId: string): Promise<string[]> {
  return (await env.PROFILES.get<string[]>(`${KV_PREFIX.conversations}${userId}`, "json")) ?? [];
}

/** Add a conversation id to a user's index (idempotent). */
export async function addConversation(env: Env, userId: string, conversationId: string): Promise<void> {
  const list = await getConversationIds(env, userId);
  if (list.includes(conversationId)) return;
  list.push(conversationId);
  await env.PROFILES.put(`${KV_PREFIX.conversations}${userId}`, JSON.stringify(list));
}