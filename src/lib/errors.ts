import type { ErrorBody } from "./types";

/** Error codes returned by the API (stable strings, safe to branch on). */
export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

/**
 * Every failure path throws one of these so the top-level handler can render
 * a consistent `{ error: { code, message } }` body.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, ErrorCode.BAD_REQUEST, message, details);
  }
  static validation(message: string, details?: unknown): ApiError {
    return new ApiError(422, ErrorCode.VALIDATION_FAILED, message, details);
  }
  static unauthorized(message = "Authentication required."): ApiError {
    return new ApiError(401, ErrorCode.UNAUTHORIZED, message);
  }
  static forbidden(message = "You are not a participant in this conversation."): ApiError {
    return new ApiError(403, ErrorCode.FORBIDDEN, message);
  }
  static notFound(message = "Not found."): ApiError {
    return new ApiError(404, ErrorCode.NOT_FOUND, message);
  }
  static conflict(message: string): ApiError {
    return new ApiError(409, ErrorCode.CONFLICT, message);
  }
  static rateLimited(message = "Slow down a little.", retryAfter?: number): ApiError {
    return new ApiError(429, ErrorCode.RATE_LIMITED, message, { retryAfter });
  }
  static tooLarge(message: string): ApiError {
    return new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, message);
  }
  static internal(message = "Something went wrong on our side."): ApiError {
    return new ApiError(500, ErrorCode.INTERNAL_ERROR, message);
  }
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function jsonResponse(
  data: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

export function errorResponse(error: ApiError): Response {
  return jsonResponse(errorBody(error.code, error.message, error.details), { status: error.status });
}