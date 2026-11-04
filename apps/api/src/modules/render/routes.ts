import { Router } from "express";
import type { DownloadUrl, PlaybackUrl } from "@clipforge/contracts";
import type { AppDeps } from "../../deps";
import { HttpError, uuidParam } from "../../http/errors";
import { getRenderJob } from "../lookups";
import { toRenderJob } from "../serializers";

function slugify(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "clip"
  );
}

export function renderRouter({ cfg, db, storage }: AppDeps): Router {
  const router = Router();

  router.get("/:id", async (req, res) => {
    res.json(toRenderJob(await getRenderJob(db, uuidParam(req.params.id, "Render"))));
  });

  async function completed(id: string | string[] | undefined) {
    const row = await getRenderJob(db, uuidParam(id, "Render"));
    if (row.status !== "completed" || !row.output_key) throw new HttpError(409, "render_not_ready", `Render is ${row.status}`);
    return row;
  }

  /** Inline URL for previewing the finished short in the review queue. */
  router.get("/:id/playback", async (req, res) => {
    const row = await completed(req.params.id);
    const signed = await storage.createReadUrl(row.output_key, { ttlSeconds: cfg.DOWNLOAD_URL_TTL_SECONDS });
    const body: PlaybackUrl = { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    res.json(body);
  });

  router.get("/:id/download", async (req, res) => {
    const row = await completed(req.params.id);
    const fileName = `${slugify(row.clip_title)}-${row.resolution}.mp4`;
    const signed = await storage.createReadUrl(row.output_key, {
      ttlSeconds: cfg.DOWNLOAD_URL_TTL_SECONDS,
      downloadFileName: fileName,
    });
    const body: DownloadUrl = { url: signed.url, fileName, expiresAt: signed.expiresAt.toISOString() };
    res.json(body);
  });

  return router;
}
