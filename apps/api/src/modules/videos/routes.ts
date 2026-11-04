import { Router } from "express";
import {
  AnalysisDefaults,
  API_PREFIX,
  CreateAnalysisRequest,
  type JobAccepted,
  type PlaybackUrl,
} from "@clipforge/contracts";
import type { AppDeps } from "../../deps";
import { HttpError, parseBody, uuidParam } from "../../http/errors";
import { enqueueAnalysis } from "../../queue";
import { getSourceVideo } from "../lookups";
import { CLIP_EXTRAS_SQL, toClip, toSourceVideo } from "../serializers";
import { getSettings } from "../settings/service";

const ACTIVE = "('queued','downloading','validating','extracting_audio','transcribing','selecting_clips')";

export function videosRouter({ cfg, db, storage }: AppDeps): Router {
  const router = Router();

  /** Library: every source video with its latest pipeline job and clip counts. */
  router.get("/", async (_req, res) => {
    const rows = await db.query(
      `SELECT v.*, row_to_json(j) AS latest_job,
              (SELECT COUNT(*) FROM clips c WHERE c.source_video_id = v.id AND c.status <> 'discarded') AS clip_total,
              (SELECT COUNT(*) FROM clips c WHERE c.source_video_id = v.id AND c.status = 'rendered') AS clip_rendered,
              (SELECT COUNT(*) FROM clips c WHERE c.source_video_id = v.id AND c.status = 'published') AS clip_published
         FROM source_videos v
         LEFT JOIN LATERAL (
           SELECT * FROM processing_jobs pj WHERE pj.source_video_id = v.id ORDER BY pj.created_at DESC LIMIT 1
         ) j ON true
        WHERE v.status <> 'pending_upload'
        ORDER BY v.created_at DESC
        LIMIT 200`,
    );
    res.json({ videos: rows.map((v) => toSourceVideo(v, v.latest_job ?? null)) });
  });

  router.get("/:id", async (req, res) => {
    const video = await getSourceVideo(db, uuidParam(req.params.id, "Video"));
    const job = await db.one("SELECT * FROM processing_jobs WHERE source_video_id = $1 ORDER BY created_at DESC LIMIT 1", [
      video.id,
    ]);
    res.json(toSourceVideo(video, job));
  });

  /** (Re-)run the pipeline. Re-analysis keeps clips you edited, rendered or published. */
  router.post("/:id/analyze", async (req, res) => {
    const id = uuidParam(req.params.id, "Video");
    const overrides = parseBody(CreateAnalysisRequest, req.body);
    const video = await getSourceVideo(db, id);
    if (video.status === "pending_upload") throw new HttpError(409, "video_not_ready", "Upload not completed");
    const settings = await getSettings(db);
    const params = AnalysisDefaults.safeParse({ ...settings.analysis, ...overrides });
    if (!params.success) throw new HttpError(400, "validation_error", "Invalid analysis options", params.error.flatten());

    const job = await db.tx(async (client) => {
      const active = await client.query(`SELECT id FROM processing_jobs WHERE source_video_id = $1 AND status IN ${ACTIVE}`, [id]);
      if (active.rowCount) {
        throw new HttpError(409, "analysis_in_progress", "Already processing this video", { jobId: active.rows[0].id });
      }
      await client.query("UPDATE source_videos SET status = 'processing' WHERE id = $1", [id]);
      return enqueueAnalysis(client, id, params.data);
    });
    const response: JobAccepted = { jobId: job.id, status: job.status, statusUrl: `${API_PREFIX}/jobs/${job.id}` };
    res.status(202).location(response.statusUrl).json(response);
  });

  router.delete("/:id", async (req, res) => {
    const video = await getSourceVideo(db, uuidParam(req.params.id, "Video"));
    const busy = await db.one(
      `SELECT 1 FROM processing_jobs WHERE source_video_id = $1 AND status IN ${ACTIVE}
       UNION ALL
       SELECT 1 FROM render_jobs r JOIN clips c ON c.id = r.clip_id
        WHERE c.source_video_id = $1 AND r.status IN ('queued','rendering')
       UNION ALL
       SELECT 1 FROM publish_jobs p JOIN clips c ON c.id = p.clip_id
        WHERE c.source_video_id = $1 AND p.status IN ('queued','publishing')
       LIMIT 1`,
      [video.id],
    );
    if (busy) throw new HttpError(409, "video_busy", "Cancel running jobs for this video first");
    const outputs = await db.query<{ blob_key: string }>(
      `SELECT o.blob_key FROM clip_outputs o JOIN render_jobs r ON r.id = o.render_job_id
         JOIN clips c ON c.id = r.clip_id WHERE c.source_video_id = $1`,
      [video.id],
    );
    await db.query("DELETE FROM source_videos WHERE id = $1", [video.id]);
    // Best-effort blob cleanup after the rows are gone.
    const keys = [video.blob_key, ...outputs.map((o) => o.blob_key)].filter((k): k is string => Boolean(k));
    await Promise.allSettled(keys.map((k) => storage.delete(k)));
    res.status(204).end();
  });

  router.get("/:id/clips", async (req, res) => {
    const video = await getSourceVideo(db, uuidParam(req.params.id, "Video"));
    const includeDiscarded = req.query.includeDiscarded === "true";
    const rows = await db.query(
      `SELECT c.*, ${CLIP_EXTRAS_SQL}
         FROM clips c
        WHERE c.source_video_id = $1 ${includeDiscarded ? "" : "AND c.status <> 'discarded'"}
        ORDER BY c.score DESC NULLS LAST, c.start_seconds`,
      [video.id],
    );
    res.json({ clips: rows.map((r) => toClip(r, r.latest_render ?? null, r.publications)) });
  });

  router.get("/:id/playback", async (req, res) => {
    const video = await getSourceVideo(db, uuidParam(req.params.id, "Video"));
    if (!video.blob_key || video.status === "pending_upload") {
      throw new HttpError(409, "video_not_ready", "The video hasn't been downloaded yet");
    }
    const signed = await storage.createReadUrl(video.blob_key, { ttlSeconds: Math.max(cfg.DOWNLOAD_URL_TTL_SECONDS, 3600) });
    const body: PlaybackUrl = { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    res.json(body);
  });

  router.get("/:id/transcript", async (req, res) => {
    const video = await getSourceVideo(db, uuidParam(req.params.id, "Video"));
    const t = await db.one(
      "SELECT language, provider, transcript_json FROM transcripts WHERE source_video_id = $1 ORDER BY created_at DESC LIMIT 1",
      [video.id],
    );
    if (!t) throw new HttpError(404, "not_found", "Transcript not available yet");
    res.json({ language: t.language, provider: t.provider, segments: t.transcript_json.segments ?? [] });
  });

  return router;
}
