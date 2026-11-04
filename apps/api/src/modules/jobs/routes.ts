import { Router } from "express";
import type { AppDeps } from "../../deps";
import { HttpError, uuidParam } from "../../http/errors";
import { getProcessingJob } from "../lookups";
import { toJob } from "../serializers";

export function jobsRouter({ db }: AppDeps): Router {
  const router = Router();

  router.get("/:id", async (req, res) => {
    res.json(toJob(await getProcessingJob(db, uuidParam(req.params.id, "Job"))));
  });

  /** Cooperative cancellation: the worker stops at its next progress update or stage boundary. */
  router.post("/:id/cancel", async (req, res) => {
    const job = await getProcessingJob(db, uuidParam(req.params.id, "Job"));
    const updated = await db.tx(async (client) => {
      const r = await client.query(
        `UPDATE processing_jobs
            SET status = 'cancelled', stage = 'Cancelled', completed_at = now()
          WHERE id = $1 AND status IN ('queued','downloading','validating','extracting_audio','transcribing','selecting_clips')
          RETURNING *`,
        [job.id],
      );
      if (!r.rowCount) throw new HttpError(409, "job_finished", `Job is already ${job.status}`);
      await client.query(
        `UPDATE source_videos SET status = CASE WHEN blob_key IS NULL OR duration_seconds IS NULL THEN 'failed' ELSE 'ready' END
          WHERE id = $1 AND status = 'processing'`,
        [job.source_video_id],
      );
      return r.rows[0];
    });
    res.json(toJob(updated));
  });

  return router;
}
