import type { Clip, Job, Publication, RenderJob, SourceVideo } from "@clipforge/contracts";

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toJob(row: any): Job {
  return {
    id: row.id,
    sourceVideoId: row.source_video_id,
    jobType: row.job_type,
    status: row.status,
    stage: row.stage,
    progressPercent: row.progress_percent,
    attempts: row.attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at)!,
  };
}

export function toSourceVideo(row: any, latestJob?: any): SourceVideo {
  return {
    id: row.id,
    origin: row.origin,
    youtubeVideoId: row.youtube_video_id,
    sourceUrl: row.source_url,
    title: row.title,
    channelTitle: row.channel_title,
    license: row.license,
    thumbnailUrl: row.thumbnail_url,
    fileSizeBytes: row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
    durationSeconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    fps: row.fps,
    status: row.status,
    createdAt: iso(row.created_at)!,
    latestJob: latestJob === undefined ? undefined : latestJob ? toJob(latestJob) : null,
    clipCounts:
      row.clip_total !== undefined
        ? { total: Number(row.clip_total), rendered: Number(row.clip_rendered), published: Number(row.clip_published) }
        : undefined,
  };
}

/** Accepts a render row optionally joined with clip_outputs columns (`output_*`). */
/** Derive what a render contains from its snapshot (`options`). */
function includedFromOptions(row: any): RenderJob["included"] {
  const kit = row.options?.brandKit;
  if (!kit) return null;
  return {
    intro: Boolean(kit.intro),
    outro: Boolean(kit.outro),
    music: Boolean(kit.music),
    logo: Boolean(kit.logo),
    captions: row.caption_style !== "none",
  };
}

export function toRenderJob(row: any): RenderJob {
  return {
    id: row.id,
    clipId: row.clip_id,
    aspectRatio: row.aspect_ratio,
    captionStyle: row.caption_style,
    resolution: row.resolution,
    status: row.status,
    progressPercent: row.progress_percent,
    errorMessage: row.error_message,
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at),
    reframeTrack: row.reframe_track ?? null,
    included: includedFromOptions(row),
    output: row.output_id
      ? {
          id: row.output_id,
          fileSizeBytes: Number(row.output_size),
          durationSeconds: row.output_duration,
          width: row.output_width,
          height: row.output_height,
          codec: row.output_codec,
        }
      : null,
  };
}

export function toPublication(row: any): Publication {
  return {
    id: row.id,
    clipId: row.clip_id,
    renderJobId: row.render_job_id,
    platform: row.platform,
    title: row.title,
    description: row.description,
    status: row.status,
    progressPercent: row.progress_percent,
    externalId: row.external_id,
    externalUrl: row.external_url,
    errorMessage: row.error_message,
    attempts: row.attempts,
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at),
    clipTitle: row.clip_title ?? undefined,
    sourceVideoTitle: row.source_title ?? undefined,
  };
}

export function toClip(row: any, latestRender?: any, publications?: any[]): Clip {
  return {
    id: row.id,
    sourceVideoId: row.source_video_id,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    title: row.title,
    hook: row.hook,
    selectionReason: row.selection_reason,
    score: row.score,
    cropCenterX: row.crop_center_x,
    reframeMode: row.reframe_mode ?? "fixed",
    cropZoom: row.crop_zoom ?? 0,
    status: row.status,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    latestRender: latestRender === undefined ? undefined : latestRender ? toRenderJob(latestRender) : null,
    publications: publications?.map(toPublication),
  };
}

/** SQL fragments: latest render (+output) and publications per clip `c`, as JSON columns. */
export const CLIP_EXTRAS_SQL = `
  (SELECT row_to_json(lr) FROM (
     SELECT r.*, o.id AS output_id, o.file_size_bytes AS output_size, o.duration_seconds AS output_duration,
            o.width AS output_width, o.height AS output_height, o.codec AS output_codec
       FROM render_jobs r LEFT JOIN clip_outputs o ON o.render_job_id = r.id
      WHERE r.clip_id = c.id ORDER BY r.created_at DESC LIMIT 1) lr) AS latest_render,
  (SELECT COALESCE(json_agg(p ORDER BY p.created_at DESC), '[]'::json)
     FROM publish_jobs p WHERE p.clip_id = c.id) AS publications`;
