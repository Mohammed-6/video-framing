import crypto from "node:crypto";
import { Router } from "express";
import { LIMITS } from "@clipforge/config";
import { CompleteUploadRequest, CreateUploadRequest, type CreateUploadResponse } from "@clipforge/contracts";
import type { AppDeps } from "../../deps";
import { HttpError, parseBody, uuidParam } from "../../http/errors";
import { blobKeys } from "../../storage";
import { getSourceVideo } from "../lookups";
import { toSourceVideo } from "../serializers";

/** Local file uploads — a secondary source next to YouTube import. */
export function uploadsRouter({ cfg, db, storage }: AppDeps): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const body = parseBody(CreateUploadRequest, req.body);
    if (body.fileSizeBytes > LIMITS.maxUploadBytes) {
      throw new HttpError(413, "file_too_large", `Uploads are limited to ${LIMITS.maxUploadBytes} bytes`);
    }
    const sourceVideoId = crypto.randomUUID();
    const blobKey = blobKeys.source(sourceVideoId, body.fileName);
    await db.query(
      `INSERT INTO source_videos (id, origin, title, original_filename, blob_key, mime_type, file_size_bytes, status)
       VALUES ($1, 'upload', $2, $3, $4, $5, $6, 'pending_upload')`,
      [sourceVideoId, body.fileName.replace(/\.[^.]+$/, ""), body.fileName, blobKey, body.contentType, body.fileSizeBytes],
    );
    const signed = await storage.createUploadUrl(blobKey, {
      contentType: body.contentType,
      maxBytes: body.fileSizeBytes,
      ttlSeconds: cfg.UPLOAD_URL_TTL_SECONDS,
    });
    const response: CreateUploadResponse = {
      sourceVideoId,
      uploadUrl: signed.url,
      uploadHeaders: signed.headers,
      blobKey,
      expiresAt: signed.expiresAt.toISOString(),
    };
    res.status(201).json(response);
  });

  router.post("/:id/complete", async (req, res) => {
    const id = uuidParam(req.params.id, "Upload");
    const body = parseBody(CompleteUploadRequest, { sourceVideoId: id, ...req.body });
    if (body.sourceVideoId !== id) throw new HttpError(400, "id_mismatch", "sourceVideoId does not match URL");
    const video = await getSourceVideo(db, id);
    if (video.blob_key !== body.blobKey) throw new HttpError(400, "blob_key_mismatch", "blobKey does not match");
    if (video.status !== "pending_upload") {
      res.json(toSourceVideo(video));
      return;
    }
    const stat = await storage.stat(video.blob_key);
    if (!stat || stat.sizeBytes === 0) {
      throw new HttpError(409, "upload_missing", "The uploaded file was not found in storage. Retry the upload.");
    }
    const updated = await db.one(
      `UPDATE source_videos SET status = 'uploaded', file_size_bytes = $2
        WHERE id = $1 AND status = 'pending_upload' RETURNING *`,
      [id, stat.sizeBytes],
    );
    res.json(toSourceVideo(updated ?? video));
  });

  return router;
}
