-- Estimated YouTube Data API quota spent by this app, per quota day.
-- Google resets the quota at midnight America/Los_Angeles, so `day` is the Pacific date.
CREATE TABLE youtube_quota_usage (
  day DATE PRIMARY KEY,
  units INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
  exhausted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
