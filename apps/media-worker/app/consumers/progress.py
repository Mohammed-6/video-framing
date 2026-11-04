from __future__ import annotations

import time

from . import jobqueue


class StageProgress:
    """Maps a stage's 0..1 progress into a job-level [lo, hi] percent band, throttled to limit DB writes."""

    def __init__(self, kind: jobqueue.Kind, job_id: str, lo: int, hi: int, min_interval: float = 2.0):
        self.kind, self.job_id, self.lo, self.hi = kind, job_id, lo, hi
        self.min_interval = min_interval
        self._last_pct = -1
        self._last_t = 0.0

    def __call__(self, fraction: float) -> None:
        pct = int(self.lo + (self.hi - self.lo) * max(0.0, min(1.0, fraction)))
        now = time.monotonic()
        if pct <= self._last_pct or (now - self._last_t < self.min_interval and fraction < 1.0):
            return
        self._last_pct, self._last_t = pct, now
        jobqueue.set_progress(self.kind, self.job_id, pct)  # raises JobCancelled if cancelled
