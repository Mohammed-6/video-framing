import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import pino from "pino";
import { API_PREFIX } from "@clipforge/contracts";
import type { AppDeps } from "./deps";
import { errorHandler, notFoundHandler } from "./http/errors";
import { requireAuth } from "./modules/auth/middleware";
import { assetsRouter } from "./modules/assets/routes";
import { authRouter } from "./modules/auth/routes";
import { clipsRouter } from "./modules/clips/routes";
import { jobsRouter } from "./modules/jobs/routes";
import { platformsRouter } from "./modules/platforms/routes";
import { publicationsRouter, reviewRouter } from "./modules/publications/routes";
import { renderRouter } from "./modules/render/routes";
import { settingsRouter } from "./modules/settings/routes";
import { uploadsRouter } from "./modules/uploads/routes";
import { videosRouter } from "./modules/videos/routes";
import { youtubeRouter } from "./modules/youtube/routes";
import { LocalStorage, localStorageRouter } from "./storage/local";

export function createApp(deps: AppDeps) {
  const app = express();
  const logger = pino({ level: deps.cfg.LOG_LEVEL });

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/healthz" } }));
  app.use(cors({ origin: deps.cfg.WEB_ORIGIN, credentials: true }));
  app.use(cookieParser());

  app.get("/healthz", async (_req, res) => {
    await deps.db.query("SELECT 1");
    res.json({ ok: true });
  });

  // Dev-only signed-URL emulation. Mounted before the JSON parser so bodies stream to disk.
  if (deps.storage instanceof LocalStorage) {
    app.use(`${API_PREFIX}/storage/local`, localStorageRouter(deps.storage));
  }

  app.use(express.json({ limit: "256kb" }));

  const v1 = express.Router();
  v1.use("/auth", authRouter(deps));
  v1.use(requireAuth(deps));
  v1.use("/youtube", youtubeRouter(deps));
  v1.use("/uploads", uploadsRouter(deps));
  v1.use("/videos", videosRouter(deps));
  v1.use("/jobs", jobsRouter(deps));
  v1.use("/clips", clipsRouter(deps));
  v1.use("/renders", renderRouter(deps));
  v1.use("/review", reviewRouter(deps));
  v1.use("/publications", publicationsRouter(deps));
  v1.use("/platforms", platformsRouter(deps));
  v1.use("/settings", settingsRouter(deps));
  v1.use("/assets", assetsRouter(deps));
  app.use(API_PREFIX, v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
