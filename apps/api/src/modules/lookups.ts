/** Typed row lookups that 404 when missing. */
import type { Db } from "../db/pool";
import { notFound } from "../http/errors";

export type SourceVideoRow = {
  id: string;
  origin: "youtube" | "upload";
  youtube_video_id: string | null;
  source_url: string | null;
  title: string;
  channel_title: string | null;
  channel_id: string | null;
  license: string | null;
  thumbnail_url: string | null;
  original_filename: string | null;
  blob_key: string | null;
  mime_type: string | null;
  file_size_bytes: string | null; // BIGINT comes back as string
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  status: string;
  created_at: Date;
};

export type ClipRow = {
  id: string;
  source_video_id: string;
  start_seconds: number;
  end_seconds: number;
  title: string;
  hook: string | null;
  selection_reason: string | null;
  score: number | null;
  crop_center_x: number;
  reframe_mode: "auto" | "fixed";
  crop_zoom: number;
  status: string;
  created_at: Date;
  updated_at: Date;
};

export const RENDER_WITH_OUTPUT_SQL = `
  SELECT r.*, o.id AS output_id, o.blob_key AS output_key, o.file_size_bytes AS output_size,
         o.duration_seconds AS output_duration, o.width AS output_width, o.height AS output_height,
         o.codec AS output_codec
    FROM render_jobs r LEFT JOIN clip_outputs o ON o.render_job_id = r.id`;

export async function getSourceVideo(db: Db, id: string): Promise<SourceVideoRow> {
  const row = await db.one<SourceVideoRow>("SELECT * FROM source_videos WHERE id = $1", [id]);
  if (!row) throw notFound("Video");
  return row;
}

export async function getClip(db: Db, id: string): Promise<ClipRow> {
  const row = await db.one<ClipRow>("SELECT * FROM clips WHERE id = $1", [id]);
  if (!row) throw notFound("Clip");
  return row;
}

export async function getProcessingJob(db: Db, id: string) {
  const row = await db.one("SELECT * FROM processing_jobs WHERE id = $1", [id]);
  if (!row) throw notFound("Job");
  return row;
}

export async function getRenderJob(db: Db, id: string) {
  const row = await db.one(
    `SELECT x.*, c.title AS clip_title FROM (${RENDER_WITH_OUTPUT_SQL} WHERE r.id = $1) x
       JOIN clips c ON c.id = x.clip_id`,
    [id],
  );
  if (!row) throw notFound("Render");
  return row;
}

export async function latestCompletedRender(db: Db, clipId: string) {
  return db.one(`${RENDER_WITH_OUTPUT_SQL} WHERE r.clip_id = $1 AND r.status = 'completed' ORDER BY r.created_at DESC LIMIT 1`, [
    clipId,
  ]);
}

export async function latestRender(db: Db, clipId: string) {
  return db.one(`${RENDER_WITH_OUTPUT_SQL} WHERE r.clip_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [clipId]);
}
