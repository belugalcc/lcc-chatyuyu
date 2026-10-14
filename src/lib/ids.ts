import type { ConversationType } from "./types";

/** Durable Object room names are the conversation ids themselves. */
export const DM_PREFIX = "dm";
export const GROUP_PREFIX = "group";

/**
 * Deterministic DM ids: sorting the two user ids means both sides always
 * resolve to the same Durable Object, without a lookup table.
 *
 *   dm:a < b
 */
export function dmConversationId(userA: string, userB: string): string {
  const [a, b] = [userA, userB].sort();
  return `${DM_PREFIX}:${a}:${b}`;
}

export function isDmConversation(id: string): boolean {
  return id.startsWith(`${DM_PREFIX}:`);
}

export function isGroupConversation(id: string): boolean {
  return id.startsWith(`${GROUP_PREFIX}:`);
}

export function conversationType(id: string): ConversationType | null {
  if (isDmConversation(id)) return "dm";
  if (isGroupConversation(id)) return "group";
  return null;
}

export function newUserId(): string {
  return `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function newMessageId(): string {
  return `m_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function newGroupId(): string {
  return `${GROUP_PREFIX}:${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

export function groupTitle(title: string | undefined, participantIds: string[]): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed;
  return `Group (${participantIds.length})`;
}

export function dmTitle(participantIds: string[], displayNameById: Record<string, string>): string {
  const other = participantIds.find((id) => displayNameById[id] !== undefined);
  return other ? (displayNameById[other] as string) : "Direct message";
}