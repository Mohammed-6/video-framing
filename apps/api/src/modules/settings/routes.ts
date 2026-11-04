import { Router } from "express";
import { UpdateSettingsRequest } from "@clipforge/contracts";
import type { AppDeps } from "../../deps";
import { HttpError, parseBody } from "../../http/errors";
import { getSettings, saveSettings } from "./service";

export function settingsRouter({ db, cfg }: AppDeps): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    res.json({
      settings: await getSettings(db),
      environment: {
        youtubeSearchEnabled: Boolean(cfg.YOUTUBE_API_KEY),
        googleOAuthFromEnv: Boolean(cfg.GOOGLE_OAUTH_CLIENT_ID && cfg.GOOGLE_OAUTH_CLIENT_SECRET),
        storageDriver: cfg.STORAGE_DRIVER,
      },
    });
  });

  router.put("/", async (req, res) => {
    const body = parseBody(UpdateSettingsRequest, req.body);
    const kit = body.render.brandKit;
    const refs = (
      [
        ["intro", kit.introAssetId],
        ["outro", kit.outroAssetId],
        ["music", kit.musicAssetId],
        ["logo", kit.logoAssetId],
      ] as const
    ).filter(([, id]) => id);
    for (const [kind, id] of refs) {
      const ok = await db.one("SELECT 1 FROM brand_assets WHERE id = $1 AND kind = $2 AND status = 'ready'", [id, kind]);
      if (!ok) throw new HttpError(422, "invalid_asset", `The selected ${kind} file doesn't exist (was it deleted?)`);
    }
    res.json({ settings: await saveSettings(db, body) });
  });

  return router;
}
