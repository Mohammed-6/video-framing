-- Speaker-following reframe.
-- auto  = the worker tracks faces and pans the 9:16 window to the active speaker
-- fixed = static crop at crop_center_x (set when the user drags the framing slider)
ALTER TABLE clips
  ADD COLUMN reframe_mode TEXT NOT NULL DEFAULT 'auto' CHECK (reframe_mode IN ('auto', 'fixed'));

-- Clips someone already framed by hand keep their framing.
UPDATE clips SET reframe_mode = 'fixed' WHERE crop_center_x <> 0.5;

-- Camera path used by the render: [[t_seconds_from_clip_start, center_x_0_to_1], ...]
ALTER TABLE render_jobs ADD COLUMN reframe_track JSONB;
