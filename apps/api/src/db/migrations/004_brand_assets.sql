-- Brand kit uploads: intro/outro videos, background music, logo images.
-- Which ones are used by default lives in app_settings.settings.render.brandKit.
CREATE TABLE brand_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('intro', 'outro', 'music', 'logo')),
  name            TEXT NOT NULL,
  blob_key        TEXT NOT NULL UNIQUE,
  content_type    TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload', 'ready')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX brand_assets_kind_idx ON brand_assets (kind, created_at DESC);
