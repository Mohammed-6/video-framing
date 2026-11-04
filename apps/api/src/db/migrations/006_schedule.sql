-- Scheduling: batches, safe crash recovery, worker liveness.

-- Posts created together by "Schedule selected" share a batch (cancel/inspect as a group).
ALTER TABLE publish_jobs ADD COLUMN batch_id UUID;
-- true = the user picked a time. Missed scheduled posts are spaced out on catch-up.
ALTER TABLE publish_jobs ADD COLUMN scheduled BOOLEAN NOT NULL DEFAULT false;
-- Set right before the irreversible platform call (final upload chunk / finish / media_publish).
-- A worker that died before this point left nothing on the platform, so the post is safely re-queued.
ALTER TABLE publish_jobs ADD COLUMN commit_started_at TIMESTAMPTZ;

UPDATE publish_jobs SET scheduled = true WHERE run_after > created_at + interval '1 minute';

CREATE INDEX publish_jobs_due_idx ON publish_jobs (run_after) WHERE status = 'queued';
CREATE INDEX publish_jobs_platform_started_idx ON publish_jobs (platform, started_at);
CREATE INDEX publish_jobs_batch_idx ON publish_jobs (batch_id) WHERE batch_id IS NOT NULL;

-- Each worker process upserts its row every ~15 s; the UI shows "worker offline" when stale.
CREATE TABLE worker_heartbeats (
  worker_id  TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
