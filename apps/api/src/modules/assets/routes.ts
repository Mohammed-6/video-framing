import crypto from "node:crypto";
import { Router } from "express";
import {
  CreateAssetUploadRequest,
  type BrandAsset,
  type BrandInclude,
  type BrandKit,
  type CreateUploadResponse,
} from "@clipforge/contracts";
import type { Db } from "../../db/pool";
import type { AppDeps } from "../../deps";
import { HttpError, notFound, parseBody, uuidParam } from "../../http/errors";
import { sanitizeFileName } from "../../storage";
import { getSettings, saveSettings } from "../settings/service";

function toAsset(row: any): BrandAsset {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    contentType: row.content_type,
    fileSizeBytes: Number(row.file_size_bytes),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Brand kit with asset IDs resolved to blob keys — what the worker needs. Mirrors app/consumers/brand.py. */
export type ResolvedBrandKit = {
  intro: { blobKey: string } | null;
  outro: { blobKey: string } | null;
  music: { blobKey: string; volume: number; duck: boolean } | null;
  logo: { blobKey: string; position: string; scale: number; opacity: number } | null;
};

export async function resolveBrandKit(db: Db, kit: BrandKit, include: Partial<BrandInclude> = {}): Promise<ResolvedBrandKit> {
  const ids = [kit.introAssetId, kit.outroAssetId, kit.musicAssetId, kit.logoAssetId].filter((v): v is string => Boolean(v));
  const rows = ids.length
    ? await db.query<{ id: string; kind: string; blob_key: string }>(
        "SELECT id, kind, blob_key FROM brand_assets WHERE id = ANY($1) AND status = 'ready'",
        [ids],
      )
    : [];
  const key = (id: string | null, kind: string) => rows.find((r) => r.id === id && r.kind === kind)?.blob_key ?? null;
  const on = (k: keyof BrandInclude) => include[k] !== false;
  const intro = on("intro") ? key(kit.introAssetId, "intro") : null;
  const outro = on("outro") ? key(kit.outroAssetId, "outro") : null;
  const music = on("music") ? key(kit.musicAssetId, "music") : null;
  const logo = on("logo") ? key(kit.logoAssetId, "logo") : null;
  return {
    intro: intro ? { blobKey: intro } : null,
    outro: outro ? { blobKey: outro } : null,
    music: music ? { blobKey: music, volume: kit.musicVolume, duck: kit.duckMusic } : null,
    logo: logo ? { blobKey: logo, position: kit.logoPosition, scale: kit.logoScale, opacity: kit.logoOpacity } : null,
  };
}

export function assetsRouter({ cfg, db, storage }: AppDeps): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const rows = await db.query("SELECT * FROM brand_assets WHERE status = 'ready' ORDER BY kind, created_at DESC");
    res.json({ assets: rows.map(toAsset) });
  });

  router.post("/", async (req, res) => {
    const body = parseBody(CreateAssetUploadRequest, req.body);
    const id = crypto.randomUUID();
    const blobKey = `assets/${body.kind}/${id}/${sanitizeFileName(body.fileName)}`;
    await db.query(
      `INSERT INTO brand_assets (id, kind, name, blob_key, content_type, file_size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, body.kind, body.fileName.replace(/\.[^.]+$/, "").slice(0, 120), blobKey, body.contentType, body.fileSizeBytes],
    );
    const signed = await storage.createUploadUrl(blobKey, {
      contentType: body.contentType,
      maxBytes: body.fileSizeBytes,
      ttlSeconds: cfg.UPLOAD_URL_TTL_SECONDS,
    });
    const response: CreateUploadResponse = {
      sourceVideoId: id,
      uploadUrl: signed.url,
      uploadHeaders: signed.headers,
      blobKey,
      expiresAt: signed.expiresAt.toISOString(),
    };
    res.status(201).json(response);
  });

  router.post("/:id/complete", async (req, res) => {
    const id = uuidParam(req.params.id, "Asset");
    const row = await db.one("SELECT * FROM brand_assets WHERE id = $1", [id]);
    if (!row) throw notFound("Asset");
    const stat = await storage.stat(row.blob_key);
    if (!stat || stat.sizeBytes === 0) throw new HttpError(409, "upload_missing", "The file was not found in storage. Retry.");
    const updated = await db.one(
      "UPDATE brand_assets SET status = 'ready', file_size_bytes = $2 WHERE id = $1 RETURNING *",
      [id, stat.sizeBytes],
    );
    res.json(toAsset(updated));
  });

  router.get("/:id/url", async (req, res) => {
    const row = await db.one("SELECT blob_key FROM brand_assets WHERE id = $1", [uuidParam(req.params.id, "Asset")]);
    if (!row) throw notFound("Asset");
    const signed = await storage.createReadUrl(row.blob_key, { ttlSeconds: cfg.DOWNLOAD_URL_TTL_SECONDS });
    res.json({ url: signed.url, expiresAt: signed.expiresAt.toISOString() });
  });

  /** Past renders keep working (they're already baked); defaults pointing here are cleared. */
  router.delete("/:id", async (req, res) => {
    const id = uuidParam(req.params.id, "Asset");
    const row = await db.one("DELETE FROM brand_assets WHERE id = $1 RETURNING *", [id]);
    if (!row) throw notFound("Asset");
    const settings = await getSettings(db);
    const kit = { ...settings.render.brandKit };
    let changed = false;
    for (const k of ["introAssetId", "outroAssetId", "musicAssetId", "logoAssetId"] as const) {
      if (kit[k] === id) {
        kit[k] = null;
        changed = true;
      }
    }
    if (changed) await saveSettings(db, { ...settings, render: { ...settings.render, brandKit: kit } });
    await storage.delete(row.blob_key).catch(() => undefined);
    res.status(204).end();
  });

  return router;
}
