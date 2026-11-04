import { Router } from "express";
import rateLimit from "express-rate-limit";
import { LoginRequest } from "@clipforge/contracts";
import type { AppDeps } from "../../deps";
import { HttpError, parseBody } from "../../http/errors";
import { SESSION_COOKIE, passwordMatches, requireAuth, signSession } from "./middleware";

export function authRouter(deps: AppDeps): Router {
  const { cfg } = deps;
  const router = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });

  router.post("/login", limiter, (req, res) => {
    const { password } = parseBody(LoginRequest, req.body);
    if (!passwordMatches(password, cfg.APP_PASSWORD)) {
      throw new HttpError(401, "invalid_credentials", "Wrong password");
    }
    res.cookie(SESSION_COOKIE, signSession(cfg), {
      httpOnly: true,
      sameSite: "lax",
      secure: cfg.NODE_ENV === "production",
      maxAge: cfg.JWT_TTL_SECONDS * 1000,
      path: "/",
    });
    res.json({ ok: true });
  });

  router.post("/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  });

  router.get("/me", requireAuth(deps), (_req, res) => {
    res.json({ ok: true, youtubeSearchEnabled: Boolean(cfg.YOUTUBE_API_KEY) });
  });

  return router;
}
