-- Manual zoom-out for fixed framing: 0 = fill the 9:16 frame, 1 = whole scene letterboxed.
ALTER TABLE clips
  ADD COLUMN crop_zoom DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (crop_zoom BETWEEN 0 AND 1);
