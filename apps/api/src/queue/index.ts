/**
 * Job queue.
 *
 * Postgres is the queue. Job rows are inserted in the same transaction as the domain
 * change and the media worker claims them with `SELECT ... FOR UPDATE SKIP LOCKED`.
 * Three queues: processing_jobs (download + analysis), render_jobs, publish_jobs.
 */
import type { AnalysisDefaults, BrandOptions, CaptionStyle, Platform, Resolution } from "@clipforge/contracts";
import type { Queryable } from "../db/pool";
import type { ResolvedBrandKit } from "../modules/assets/routes";

export const JOB_CHANNEL = "clipforge_jobs";

async function notify(client: Queryable, kind: string, id: string) {
  await client.query("SELECT pg_notify($1, $2)", [JOB_CHANNEL, JSON.stringify({ kind, id })]);
}

export async function enqueueAnalysis(client: Queryable, sourceVideoId: string, params: AnalysisDefaults) {
  const { rows } = await client.query(
    `INSERT INTO processing_jobs (source_video_id, job_type, status, stage, params)
     VALUES ($1, 'analysis', 'queued', 'Waiting for a worker', $2)
     RETURNING *`,
    [sourceVideoId, JSON.stringify(params)],
  );
  await notify(client, "analysis", rows[0]!.id);
  return rows[0]!;
}

/** Everything needed to reproduce a render; also built by the worker for auto-renders. */
export type RenderSnapshot = {
  aspectRatio: "9:16";
  captionStyle: CaptionStyle;
  resolution: Resolution;
  brand: BrandOptions;
  sourceBlobKey: string;
  sourceWidth: number | null;
  sourceHeight: number | null;
  startSeconds: number;
  endSeconds: number;
  cropCenterX: number;
  reframeMode: "auto" | "fixed";
  cropZoom: number;
  multiFace: "group" | "speaker";
  steadyZoom: boolean;
  brandKit: ResolvedBrandKit;
  letterboxFill: "blur" | "black";
  title: string;
};

export const renderBlobKey = (renderId: string) => `renders/${renderId}.mp4`;

export async function enqueueRender(client: Queryable, args: { renderId: string; clipId: string; snapshot: RenderSnapshot }) {
  const { snapshot } = args;
  const { rows } = await client.query(
    `INSERT INTO render_jobs (id, clip_id, aspect_ratio, caption_style, resolution, options, output_blob_key, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
     RETURNING *`,
    [
      args.renderId,
      args.clipId,
      snapshot.aspectRatio,
      snapshot.captionStyle,
      snapshot.resolution,
      JSON.stringify(snapshot),
      renderBlobKey(args.renderId),
    ],
  );
  await notify(client, "render", rows[0]!.id);
  return rows[0]!;
}

export async function enqueuePublish(
  client: Queryable,
  args: {
    clipId: string;
    renderJobId: string;
    platform: Platform;
    title: string;
    description: string;
  },
) {
  const { rows } = await client.query(
    `INSERT INTO publish_jobs (clip_id, render_job_id, platform, title, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [args.clipId, args.renderJobId, args.platform, args.title, args.description],
  );
  await notify(client, "publish", rows[0]!.id);
  return rows[0]!;
}
