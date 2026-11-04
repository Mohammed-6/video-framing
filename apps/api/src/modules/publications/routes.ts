import { Router } from "express";
import type { ReviewItem } from "@clipforge/contracts";
import type { AppDeps } from "../../deps";
import { HttpError, uuidParam } from "../../http/errors";
import { buildDraft, isConnected, listPlatformRows, safeDecrypt } from "../platforms/service";
import { toClip, toPublication } from "../serializers";

export function publicationsRouter({ db }: AppDeps): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const rows = await db.query(
      `SELECT p.*, c.title AS clip_title, v.title AS source_title
         FROM publish_jobs p JOIN clips c ON c.id = p.clip_id JOIN source_videos v ON v.id = c.source_video_id
        ${status ? "WHERE p.status = $1" : ""}
        ORDER BY p.run_after DESC LIMIT 300`,
      status ? [status] : [],
    );
    res.json({ publications: rows.map(toPublication) });
  });

  router.post("/:id/cancel", async (req, res) => {
    const id = uuidParam(req.params.id, "Publication");
    const row = await db.one(
      "UPDATE publish_jobs SET status = 'cancelled', completed_at = now() WHERE id = $1 AND status = 'queued' RETURNING *",
      [id],
    );
    if (!row) throw new HttpError(409, "not_cancellable", "Only posts that haven't started can be cancelled");
    res.json(toPublication(row));
  });

  /**
   * Retry a failed/cancelled post. Note: a failure *after* the platform accepted the upload
   * can mean the video is live already — the error message says so when the worker knows.
   */
  router.post("/:id/retry", async (req, res) => {
    const id = uuidParam(req.params.id, "Publication");
    const row = await db.one(
      `UPDATE publish_jobs SET status = 'queued', attempts = 0, run_after = now(), error_message = NULL,
              progress_percent = 0, completed_at = NULL, commit_started_at = NULL
        WHERE id = $1 AND status IN ('failed','cancelled') RETURNING *`,
      [id],
    );
    if (!row) throw new HttpError(409, "not_retryable", "Only failed or cancelled posts can be retried");
    res.json(toPublication(row));
  });

  return router;
}

/** Review queue: rendered clips that haven't been sent anywhere yet. */
export function reviewRouter({ db, cipher }: AppDeps): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    const rows = await db.query(
      `SELECT c.*, row_to_json(lr) AS latest_render,
              v.id AS v_id, v.title AS v_title, v.channel_title AS v_channel, v.source_url AS v_url,
              v.thumbnail_url AS v_thumb
         FROM clips c
         JOIN source_videos v ON v.id = c.source_video_id
         JOIN LATERAL (
           SELECT r.*, o.id AS output_id, o.file_size_bytes AS output_size, o.duration_seconds AS output_duration,
                  o.width AS output_width, o.height AS output_height, o.codec AS output_codec
             FROM render_jobs r JOIN clip_outputs o ON o.render_job_id = r.id
            WHERE r.clip_id = c.id AND r.status = 'completed'
            ORDER BY r.created_at DESC LIMIT 1
         ) lr ON true
        WHERE c.status = 'rendered'
          AND NOT EXISTS (SELECT 1 FROM publish_jobs p WHERE p.clip_id = c.id AND p.status IN ('queued','publishing','published'))
        ORDER BY v.created_at DESC, c.score DESC NULLS LAST
        LIMIT 100`,
    );
    const pending = await db.one<{ rendering: string; analyzing: string }>(
      `SELECT (SELECT COUNT(*) FROM render_jobs WHERE status IN ('queued','rendering')) AS rendering,
              (SELECT COUNT(*) FROM processing_jobs
                WHERE status IN ('queued','downloading','validating','extracting_audio','transcribing','selecting_clips')) AS analyzing`,
    );
    const platforms = (await listPlatformRows(db)).filter((p) => p.enabled && isConnected(p, safeDecrypt(cipher, p.credentials)));
    const items: ReviewItem[] = rows.map((r) => {
      const src = { title: r.title, hook: r.hook, sourceTitle: r.v_title, sourceChannel: r.v_channel, sourceUrl: r.v_url };
      return {
        ...toClip(r, r.latest_render),
        latestRender: toClip(r, r.latest_render).latestRender!,
        sourceVideo: { id: r.v_id, title: r.v_title, channelTitle: r.v_channel, sourceUrl: r.v_url, thumbnailUrl: r.v_thumb },
        drafts: platforms.map((p) => buildDraft(p, src)),
      };
    });
    res.json({
      items,
      pending: { rendering: Number(pending?.rendering ?? 0), analyzing: Number(pending?.analyzing ?? 0) },
      readyPlatforms: platforms.map((p) => p.platform),
    });
  });
  return router;
}
