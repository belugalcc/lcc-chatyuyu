import { z } from "zod";
import { ApiError } from "./errors";
import { clampText, sanitizeUrl } from "./sanitize";

/**
 * Server-side validation. Every request body and query string goes through
 * here so the Durable Objects can trust their input.
 */

export const DISPLAY_NAME_MAX = 32;
export const GROUP_TITLE_MAX = 48;
export const MESSAGE_MAX_DEFAULT = 4000;

export function messageLimit(env: { MAX_MESSAGE_LENGTH?: string }): number {
  const parsed = Number.parseInt(env.MAX_MESSAGE_LENGTH ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 8000) : MESSAGE_MAX_DEFAULT;
}

const displayName = z
  .string()
  .transform((value) => clampText(value, DISPLAY_NAME_MAX))
  .refine((value) => value.length >= 2, { message: "Pick a name with at least 2 characters." })
  .refine((value) => value.length <= DISPLAY_NAME_MAX, {
    message: `Names are limited to ${DISPLAY_NAME_MAX} characters.`,
  });

export const createSessionSchema = z.object({
  displayName,
  avatarUrl: z.string().max(2048).optional(),
});

export const updateProfileSchema = z.object({
  displayName: displayName.optional(),
  avatarUrl: z.string().max(2048).optional(),
});

const userId = z.string().regex(/^u_[a-z0-9]{8,32}$/, "Invalid user id.");

export const dmSchema = z.object({
  userId,
});

export const groupSchema = z.object({
  title: z
    .string()
    .transform((value) => clampText(value, GROUP_TITLE_MAX))
    .optional(),
  participantIds: z.array(userId).max(24, "Groups are limited to 24 members."),
});

export const readReceiptSchema = z.object({
  messageIds: z.array(z.string().min(1).max(64)).max(500),
});

export const messageSendSchema = (max: number) =>
  z.object({
    content: z
      .string()
      .transform((value) => clampText(value, max))
      .refine((value) => value.length > 0, { message: "Message cannot be empty." })
      .refine((value) => value.length <= max, { message: `Messages are limited to ${max} characters.` }),
    clientMessageId: z.string().max(64).optional(),
  });

export const searchSchema = z.object({
  q: z.string().max(64).optional(),
});

/** Parse `input` or throw a 422 ApiError carrying per-field details. */
export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown, label = "body"): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join(".") || label,
      message: issue.message,
    }));
    throw ApiError.validation("The request body is invalid.", details);
  }
  return result.data;
}

export function parseJsonBody(request: Request, maxBytes = 16 * 1024): unknown {
  const length = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > maxBytes) throw ApiError.tooLarge("Request body is too large.");
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("application/json")) {
    throw ApiError.badRequest("Expected a JSON request body.");
  }
  return request.json().catch(() => {
    throw ApiError.badRequest("Request body must be valid JSON.");
  });
}

export { sanitizeUrl };