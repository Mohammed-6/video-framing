import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import type { AppDeps } from "../../deps";
import { HttpError } from "../../http/errors";

export const SESSION_COOKIE = "cf_session";
const SUBJECT = "owner";

export function signSession(cfg: AppDeps["cfg"]): string {
  return jwt.sign({ sub: SUBJECT }, cfg.JWT_SECRET, { expiresIn: cfg.JWT_TTL_SECONDS, algorithm: "HS256" });
}

/** Constant-time password check (hash both sides so lengths match). */
export function passwordMatches(given: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const cookie = req.cookies?.[SESSION_COOKIE];
  return typeof cookie === "string" && cookie ? cookie : null;
}

/** Single-owner tool: a valid session JWT is the only requirement. */
export function requireAuth({ cfg }: AppDeps): RequestHandler {
  return (req, _res, next) => {
    const token = extractToken(req);
    if (!token) throw new HttpError(401, "unauthenticated", "Sign in required");
    try {
      const claims = jwt.verify(token, cfg.JWT_SECRET, { algorithms: ["HS256"] }) as { sub?: string };
      if (claims.sub !== SUBJECT) throw new Error("bad subject");
    } catch {
      throw new HttpError(401, "unauthenticated", "Session expired or invalid");
    }
    next();
  };
}
