-- ClipForge schema (single-owner automation tool).
-- The API owns migrations; the Python media worker reads/writes these tables.
--
-- Flow: source_videos (YouTube import or upload)
--   -> processing_jobs (download, transcribe, select clips)
--   -> clips -> render_jobs/clip_outputs (auto-rendered)
--   -> you review -> publish_jobs (one per clip x platform)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Source videos
-- ---------------------------------------------------------------------------

CREATE TABLE source_videos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origin            TEXT NOT NULL CHECK (origin IN ('youtube', 'upload')),
  youtube_video_id  TEXT UNIQUE,
  source_url        TEXT,
  title             TEXT NOT NULL,
  channel_title     TEXT,
  channel_id        TEXT,
  license           TEXT,                -- 'youtube' | 'creativeCommon' for YouTube imports
  thumbnail_url     TEXT,
  original_filename TEXT,
  blob_key          TEXT UNIQUE,         -- set once uploaded/downloaded
  mime_type         TEXT,
  file_size_bytes   BIGINT,
  duration_seconds  DOUBLE PRECISION,
  width             INTEGER,
  height            INTEGER,
  fps               DOUBLE PRECISION,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'pending_upload', 'uploaded', 'processing', 'ready', 'failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX source_videos_created_idx ON source_videos (created_at DESC);

-- ---------------------------------------------------------------------------
-- Analysis pipeline jobs (also the work queue: workers claim rows with SKIP LOCKED)
-- ---------------------------------------------------------------------------

CREATE TABLE processing_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_video_id  UUID NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  job_type         TEXT NOT NULL DEFAULT 'analysis' CHECK (job_type IN ('analysis')),
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                     'queued', 'downloading', 'validating', 'extracting_audio', 'transcribing',
                     'selecting_clips', 'clips_ready', 'failed', 'cancelled')),
  stage            TEXT,
  progress_percent SMALLINT NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  params           JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts         SMALLINT NOT NULL DEFAULT 0,
  max_attempts     SMALLINT NOT NULL DEFAULT 3,
  run_after        TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by        TEXT,
  heartbeat_at     TIMESTAMPTZ,
  error_code       TEXT,
  error_message    TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX processing_jobs_status_idx ON processing_jobs (status, created_at);
CREATE INDEX processing_jobs_video_idx ON processing_jobs (source_video_id, created_at DESC);
CREATE UNIQUE INDEX processing_jobs_one_active_per_video
  ON processing_jobs (source_video_id)
  WHERE status IN ('queued', 'downloading', 'validating', 'extracting_audio', 'transcribing', 'selecting_clips');

CREATE TABLE transcripts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_video_id UUID NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  language        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  transcript_json JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transcripts_video_idx ON transcripts (source_video_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Clips & rendering
-- ---------------------------------------------------------------------------

CREATE TABLE clips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_video_id   UUID NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  processing_job_id UUID REFERENCES processing_jobs(id) ON DELETE SET NULL,
  start_seconds     DOUBLE PRECISION NOT NULL CHECK (start_seconds >= 0),
  end_seconds       DOUBLE PRECISION NOT NULL,
  title             TEXT NOT NULL,
  hook              TEXT,
  selection_reason  TEXT,
  score             DOUBLE PRECISION,
  crop_center_x     DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (crop_center_x BETWEEN 0 AND 1),
  -- candidate -> rendered -> (published) ; edited = bounds changed since last render
  status            TEXT NOT NULL DEFAULT 'candidate'
                    CHECK (status IN ('candidate', 'edited', 'rendered', 'published', 'discarded')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_seconds > start_seconds)
);
CREATE INDEX clips_video_score_idx ON clips (source_video_id, score DESC);
CREATE INDEX clips_status_idx ON clips (status, updated_at DESC);

CREATE TABLE render_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id          UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  aspect_ratio     TEXT NOT NULL DEFAULT '9:16',
  caption_style    TEXT NOT NULL,
  resolution       TEXT NOT NULL,
  options          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'rendering', 'completed', 'failed', 'cancelled')),
  progress_percent SMALLINT NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  attempts         SMALLINT NOT NULL DEFAULT 0,
  max_attempts     SMALLINT NOT NULL DEFAULT 3,
  run_after        TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by        TEXT,
  heartbeat_at     TIMESTAMPTZ,
  output_blob_key  TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);
CREATE INDEX render_jobs_status_idx ON render_jobs (status, created_at);
CREATE INDEX render_jobs_clip_idx ON render_jobs (clip_id, created_at DESC);

CREATE TABLE clip_outputs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  render_job_id    UUID NOT NULL UNIQUE REFERENCES render_jobs(id) ON DELETE CASCADE,
  blob_key         TEXT NOT NULL,
  file_size_bytes  BIGINT NOT NULL,
  duration_seconds DOUBLE PRECISION NOT NULL,
  width            INTEGER NOT NULL,
  height           INTEGER NOT NULL,
  codec            TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Publishing
-- ---------------------------------------------------------------------------

-- One row per platform. `credentials` is AES-256-GCM ciphertext (CREDENTIALS_KEY);
-- `config` holds non-secret settings (page id, privacy status, ...).
CREATE TABLE platform_accounts (
  platform         TEXT PRIMARY KEY CHECK (platform IN ('youtube', 'facebook', 'instagram')),
  enabled          BOOLEAN NOT NULL DEFAULT false,
  display_name     TEXT,
  config           JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials      TEXT,
  caption_template TEXT,
  hashtags         TEXT,
  connected_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_accounts (platform) VALUES ('youtube'), ('facebook'), ('instagram');

CREATE TABLE publish_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id         UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  render_job_id   UUID NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL REFERENCES platform_accounts(platform),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'publishing', 'published', 'failed', 'cancelled')),
  progress_percent SMALLINT NOT NULL DEFAULT 0,
  attempts        SMALLINT NOT NULL DEFAULT 0,
  max_attempts    SMALLINT NOT NULL DEFAULT 3,
  run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),  -- future = scheduled
  locked_by       TEXT,
  heartbeat_at    TIMESTAMPTZ,
  external_id     TEXT,
  external_url    TEXT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);
CREATE INDEX publish_jobs_status_idx ON publish_jobs (status, run_after);
CREATE INDEX publish_jobs_clip_idx ON publish_jobs (clip_id, created_at DESC);
-- Never post the same clip twice to one platform unless the earlier attempt failed/cancelled.
CREATE UNIQUE INDEX publish_jobs_one_live_per_platform
  ON publish_jobs (clip_id, platform)
  WHERE status IN ('queued', 'publishing', 'published');

-- ---------------------------------------------------------------------------
-- App settings (single row): defaults for analysis, rendering and automation
-- ---------------------------------------------------------------------------

CREATE TABLE app_settings (
  id         BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (true);
