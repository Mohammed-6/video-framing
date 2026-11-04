import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError, ZodType, ZodTypeDef } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`);

export function parseBody<T>(schema: ZodType<T, ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new HttpError(400, "validation_error", "Request validation failed", result.error.flatten());
  }
  return result.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate an :id path param. Non-UUIDs are reported as 404 so probing reveals nothing. */
export function uuidParam(value: string | string[] | undefined, what = "Resource"): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw notFound(what);
  return value;
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: "validation_error", message: "Invalid request", details: err.flatten() } });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "invalid_json", message: "Malformed JSON body" } });
    return;
  }
  // Postgres unique violation that slipped past an application-level check (race).
  if (err?.code === "23505") {
    res.status(409).json({ error: { code: "conflict", message: "Conflicting resource state" } });
    return;
  }
  req.log?.error({ err }, "unhandled error");
  res.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
};
