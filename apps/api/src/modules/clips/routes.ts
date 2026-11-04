import crypto from "node:crypto";
import { Router } from "express";
import {
  API_PREFIX,
  PublishClipRequest,
  RenderClipRequest,
  UpdateClipRequest,
  type ClipDetail,
  type TranscriptSegment,
} from "@clipforge/contracts";
import type { AppDeps } from "../../deps";
import { HttpError, parseBody, uuidParam } from "../../http/errors";
import { enqueuePublish, enqueueRender, type RenderSnapshot } from "../../queue";
import { resolveBrandKit } from "../assets/routes";
import { getClip, getSourceVideo, latestCompletedRender, latestRender } from "../lookups";
import { buildDraft, getPlatformRow, isConnected, safeDecrypt } from "../platforms/service";
import { toClip, toPublication, toRenderJob, toSourceVideo } from "../serializers";
import { getSettings } from "../settings/service";
import { validateClipBounds } from "./validation";

const TRANSCRIPT_CONTEXT_SECONDS = 120;

export function clipsRouter({ db, cipher }: AppDeps): Router {
  const router = Router();

  async function publications(clipId: string) {
    return db.query("SELECT * FROM publish_jobs WHERE clip_id = $1 ORDER BY created_at DESC", [clipId]);
  }

  router.get("/:id", async (req, res) => {
    const clip = await getClip(db, uuidParam(req.params.id, "Clip"));
    const video = await getSourceVideo(db, clip.source_video_id);
    const [latest, pubs, segRows] = await Promise.all([
      latestRender(db, clip.id),
      publications(clip.id),
      db.query<{ seg: TranscriptSegment }>(
        `SELECT seg
           FROM (SELECT transcript_json FROM transcripts WHERE source_video_id = $1 ORDER BY created_at DESC LIMIT 1) t,
                jsonb_array_elements(t.transcript_json -> 'segments') AS seg
          WHERE (seg ->> 'end')::float8 >= $2 AND (seg ->> 'start')::float8 <= $3
          ORDER BY (seg ->> 'start')::float8`,
        [video.id, clip.start_seconds - TRANSCRIPT_CONTEXT_SECONDS, clip.end_seconds + TRANSCRIPT_CONTEXT_SECONDS],
      ),
    ]);
    const detail: ClipDetail = {
      ...toClip(clip, latest, pubs),
      sourceVideo: toSourceVideo(video),
      transcriptSegments: segRows.map((r) => r.seg),
    };
    res.json(detail);
  });

  router.patch("/:id", async (req, res) => {
    const clip = await getClip(db, uuidParam(req.params.id, "Clip"));
    const body = parseBody(UpdateClipRequest, req.body);
    const video = await getSourceVideo(db, clip.source_video_id);

    let start = clip.start_seconds;
    let end = clip.end_seconds;
    if (body.startSeconds !== undefined || body.endSeconds !== undefined) {
      const check = validateClipBounds(body.startSeconds ?? start, body.endSeconds ?? end, video.duration_seconds);
      if (!check.ok) throw new HttpError(422, "invalid_clip_bounds", check.message);
      start = check.start;
      end = check.end;
    }
    // Changes that affect the rendered pixels make the current render stale.
    // Dragging the framing slider implies a fixed crop unless a mode is given explicitly.
    const manualFraming = body.cropCenterX !== undefined || body.cropZoom !== undefined;
    const reframeMode = body.reframeMode ?? (manualFraming ? "fixed" : clip.reframe_mode);
    const cropZoom = body.cropZoom ?? clip.crop_zoom;
    const visualChange =
      start !== clip.start_seconds ||
      end !== clip.end_seconds ||
      reframeMode !== clip.reframe_mode ||
      cropZoom !== clip.crop_zoom ||
      (body.cropCenterX !== undefined && body.cropCenterX !== clip.crop_center_x);
    let status = clip.status;
    if (body.status) status = body.status;
    else if (visualChange && clip.status !== "published") status = "edited";

    const updated = await db.one(
      `UPDATE clips SET start_seconds = $2, end_seconds = $3, title = $4, hook = $5, crop_center_x = $6,
                        status = $7, reframe_mode = $8, crop_zoom = $9, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        clip.id,
        start,
        end,
        body.title ?? clip.title,
        body.hook ?? clip.hook,
        body.cropCenterX ?? clip.crop_center_x,
        status,
        reframeMode,
        cropZoom,
      ],
    );
    res.json(toClip(updated));
  });

  /** Queue a render with the request's options layered over the saved defaults. */
  router.post("/:id/render", async (req, res) => {
    const clip = await getClip(db, uuidParam(req.params.id, "Clip"));
    if (clip.status === "discarded") throw new HttpError(409, "clip_discarded", "Restore the clip before rendering");
    const body = parseBody(RenderClipRequest, req.body);
    const video = await getSourceVideo(db, clip.source_video_id);
    if (!video.blob_key) throw new HttpError(409, "video_not_ready", "Source video isn't downloaded yet");
    const defaults = (await getSettings(db)).render;

    const renderId = crypto.randomUUID();
    const include = { ...defaults.include, ...body.include };
    const snapshot: RenderSnapshot = {
      aspectRatio: "9:16",
      captionStyle: include.captions ? (body.captionStyle ?? defaults.captionStyle) : "none",
      resolution: body.resolution ?? defaults.resolution,
      brand: body.brand ?? defaults.brand,
      sourceBlobKey: video.blob_key,
      sourceWidth: video.width,
      sourceHeight: video.height,
      startSeconds: clip.start_seconds,
      endSeconds: clip.end_seconds,
      cropCenterX: clip.crop_center_x,
      reframeMode: clip.reframe_mode,
      cropZoom: clip.crop_zoom,
      multiFace: body.multiFace ?? defaults.multiFace,
      steadyZoom: body.steadyZoom ?? defaults.steadyZoom,
      brandKit: await resolveBrandKit(db, defaults.brandKit, include),
      letterboxFill: body.letterboxFill ?? defaults.letterboxFill,
      title: clip.title,
    };
    const job = await db.tx(async (client) => {
      const active = await client.query(
        "SELECT id FROM render_jobs WHERE clip_id = $1 AND status IN ('queued','rendering') FOR UPDATE",
        [clip.id],
      );
      if (active.rowCount) {
        throw new HttpError(409, "render_in_progress", "This clip is already rendering", { renderId: active.rows[0].id });
      }
      return enqueueRender(client, { renderId, clipId: clip.id, snapshot });
    });
    const statusUrl = `${API_PREFIX}/renders/${job.id}`;
    res.status(202).location(statusUrl).json({ ...toRenderJob(job), statusUrl });
  });

  router.get("/:id/renders", async (req, res) => {
    const clip = await getClip(db, uuidParam(req.params.id, "Clip"));
    const rows = await db.query(
      `SELECT r.*, o.id AS output_id, o.file_size_bytes AS output_size, o.duration_seconds AS output_duration,
              o.width AS output_width, o.height AS output_height, o.codec AS output_codec
         FROM render_jobs r LEFT JOIN clip_outputs o ON o.render_job_id = r.id
        WHERE r.clip_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
      [clip.id],
    );
    res.json({ renders: rows.map(toRenderJob) });
  });

  /** Default title/description per enabled platform, from each platform's template. */
  router.get("/:id/drafts", async (req, res) => {
    const clip = await getClip(db, uuidParam(req.params.id, "Clip"));
    const video = await getSourceVideo(db, clip.source_video_id);
    const rows = await db.query("SELECT * FROM platform_accounts ORDER BY platform");
    res.json({
      drafts: rows.map((r: any) =>
        buildDraft(r, {
          title: clip.title,
          hook: clip.hook,
          sourceTitle: video.title,
          sourceChannel: video.channel_title,
          sourceUrl: video.source_url,
        }),
      ),
    });
  });

  /** Approve a clip: queue one publish job per platform. */
  router.post("/:id/publish", async (req, res) => {
    const clip = await getClip(db, uuidParam(req.params.id, "Clip"));
    const body = parseBody(PublishClipRequest, req.body);
    if (clip.status === "discarded") throw new HttpError(409, "clip_discarded", "This clip was discarded");
    if (clip.status === "edited" || clip.status === "candidate") {
      throw new HttpError(409, "render_stale", "Render the clip with your latest edits before publishing");
    }
    const render = await latestCompletedRender(db, clip.id);
    if (!render?.output_id) throw new HttpError(409, "not_rendered", "This clip has no finished render yet");
    const video = await getSourceVideo(db, clip.source_video_id);

    const platforms = [...new Set(body.targets.map((t) => t.platform))];
    const rows = await Promise.all(platforms.map((p) => getPlatformRow(db, p)));
    for (const row of rows) {
      if (!row.enabled || !isConnected(row, safeDecrypt(cipher, row.credentials))) {
        throw new HttpError(422, "platform_not_ready", `${row.platform} is not connected and enabled (see Settings)`);
      }
    }

    const created = await db.tx(async (client) => {
      const out = [];
      for (const row of rows) {
        const target = body.targets.find((t) => t.platform === row.platform)!;
        const draft = buildDraft(row, {
          title: clip.title,
          hook: clip.hook,
          sourceTitle: video.title,
          sourceChannel: video.channel_title,
          sourceUrl: video.source_url,
        });
        const live = await client.query(
          "SELECT status FROM publish_jobs WHERE clip_id = $1 AND platform = $2 AND status IN ('queued','publishing','published')",
          [clip.id, row.platform],
        );
        if (live.rowCount) {
          throw new HttpError(409, "already_published", `Already ${live.rows[0].status} on ${row.platform}`);
        }
        out.push(
          await enqueuePublish(client, {
            clipId: clip.id,
            renderJobId: render.id,
            platform: row.platform,
            title: target.title ?? draft.title,
            description: target.description ?? draft.description,
          }),
        );
      }
      return out;
    });
    res.status(202).json({ publications: created.map(toPublication) });
  });

  router.get("/:id/publications", async (req, res) => {
    const clip = await getClip(db, uuidParam(req.params.id, "Clip"));
    res.json({ publications: (await publications(clip.id)).map(toPublication) });
  });

  return router;
}
