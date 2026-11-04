-- Scheduling was removed from the app. Keep commit_started_at (safe re-queue of posts
-- interrupted before they reached the platform); drop the scheduling-only bits.
-- Any post still waiting for a future time is cancelled so it never goes out unexpectedly.
UPDATE publish_jobs SET status = 'cancelled', completed_at = now()
 WHERE status = 'queued' AND run_after > now() + interval '1 minute';
DROP INDEX IF EXISTS publish_jobs_batch_idx;
ALTER TABLE publish_jobs DROP COLUMN IF EXISTS batch_id;
ALTER TABLE publish_jobs DROP COLUMN IF EXISTS scheduled;
DROP TABLE IF EXISTS worker_heartbeats;
