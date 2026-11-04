"""Postgres-backed job queue operations (claim, heartbeat, progress, finish, recover).

Rows are claimed with `FOR UPDATE SKIP LOCKED`, so any number of workers can poll
the same tables without double-processing. A heartbeat thread keeps `heartbeat_at`
fresh; rows whose worker died are re-queued (or failed after `max_attempts`).
"""

from __future__ import annotations

import logging
import threading
from typing import Literal

from ..db import connect
from ..errors import JobCancelled

log = logging.getLogger(__name__)

Kind = Literal["analysis", "render", "publish"]

ANALYSIS_ACTIVE = ("downloading", "validating", "extracting_audio", "transcribing", "selecting_clips")
TABLE = {"analysis": "processing_jobs", "render": "render_jobs", "publish": "publish_jobs"}


# Oldest due post first. `started_at` is the claim time of the latest attempt.
PUBLISH_CLAIM_SQL = """
    UPDATE publish_jobs p
       SET status = 'publishing', progress_percent = 0, attempts = attempts + 1,
           locked_by = %(w)s, heartbeat_at = now(), started_at = now(),
           error_message = NULL, commit_started_at = NULL
     WHERE p.id = (
           SELECT j.id FROM publish_jobs j
            WHERE j.status = 'queued' AND j.run_after <= now()
            ORDER BY j.run_after
            FOR UPDATE SKIP LOCKED
            LIMIT 1)
    RETURNING p.*"""


def mark_commit(job_id: str) -> None:
    """Called right before the irreversible platform call; see recover_stale."""
    with connect() as conn:
        conn.execute("UPDATE publish_jobs SET commit_started_at = now() WHERE id = %s", (job_id,))



def claim(kind: Kind, worker_id: str) -> dict | None:
    if kind == "analysis":
        sql = """
            UPDATE processing_jobs j
               SET status = 'validating', stage = 'Validating source video', progress_percent = 2,
                   attempts = attempts + 1, locked_by = %(w)s, heartbeat_at = now(),
                   started_at = COALESCE(started_at, now()), error_code = NULL, error_message = NULL
             WHERE j.id = (
                   SELECT id FROM processing_jobs
                    WHERE status = 'queued' AND run_after <= now()
                    ORDER BY created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1)
            RETURNING j.*"""
    elif kind == "publish":
        sql = PUBLISH_CLAIM_SQL
    else:
        sql = """
            UPDATE render_jobs r
               SET status = 'rendering', progress_percent = 1, attempts = attempts + 1,
                   locked_by = %(w)s, heartbeat_at = now(), started_at = COALESCE(started_at, now()),
                   error_message = NULL
             WHERE r.id = (
                   SELECT id FROM render_jobs
                    WHERE status = 'queued' AND run_after <= now()
                    ORDER BY created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1)
            RETURNING r.*"""
    with connect() as conn:
        return conn.execute(sql, {"w": worker_id}).fetchone()


def set_stage(job_id: str, status: str, stage: str, progress: int) -> None:
    """Advance an analysis job. Raises JobCancelled if the user cancelled it meanwhile."""
    with connect() as conn:
        cur = conn.execute(
            """UPDATE processing_jobs SET status = %s, stage = %s, progress_percent = %s, heartbeat_at = now()
                WHERE id = %s AND status <> 'cancelled'""",
            (status, stage, max(0, min(100, progress)), job_id),
        )
        if cur.rowcount == 0:
            raise JobCancelled()


def set_progress(kind: Kind, job_id: str, progress: int) -> None:
    table = TABLE[kind]
    with connect() as conn:
        cur = conn.execute(
            f"UPDATE {table} SET progress_percent = GREATEST(progress_percent, %s), heartbeat_at = now() "
            f"WHERE id = %s AND status <> 'cancelled'",
            (max(0, min(100, progress)), job_id),
        )
        if cur.rowcount == 0:
            raise JobCancelled()


def is_cancelled(kind: Kind, job_id: str) -> bool:
    with connect() as conn:
        row = conn.execute(f"SELECT status FROM {TABLE[kind]} WHERE id = %s", (job_id,)).fetchone()
        return row is None or row["status"] == "cancelled"


def fail(kind: Kind, job: dict, code: str, message: str, retryable: bool) -> bool:
    """Mark a job failed or schedule a retry with exponential backoff. Returns True if it will retry."""
    retry = retryable and job["attempts"] < job["max_attempts"]
    backoff = 30 * (2 ** max(0, job["attempts"] - 1))
    with connect() as conn:
        if kind == "analysis":
            if retry:
                conn.execute(
                    """UPDATE processing_jobs SET status = 'queued', stage = %s, error_code = %s, error_message = %s,
                              run_after = now() + make_interval(secs => %s), locked_by = NULL
                        WHERE id = %s AND status <> 'cancelled'""",
                    (f"Retrying after error: {code}", code, message[:2000], backoff, job["id"]),
                )
            else:
                conn.execute(
                    """UPDATE processing_jobs SET status = 'failed', stage = 'Failed', error_code = %s,
                              error_message = %s, completed_at = now(), locked_by = NULL
                        WHERE id = %s AND status <> 'cancelled'""",
                    (code, message[:2000], job["id"]),
                )
                conn.execute(
                    "UPDATE source_videos SET status = 'failed' WHERE id = %s AND status = 'processing'",
                    (job["source_video_id"],),
                )
        else:
            table = TABLE[kind]
            if retry:
                conn.execute(
                    f"""UPDATE {table} SET status = 'queued', error_message = %s, progress_percent = 0,
                              run_after = now() + make_interval(secs => %s), locked_by = NULL
                        WHERE id = %s AND status <> 'cancelled'""",
                    (f"{code}: {message}"[:2000], backoff, job["id"]),
                )
            else:
                conn.execute(
                    f"""UPDATE {table} SET status = 'failed', error_message = %s, completed_at = now(),
                              locked_by = NULL
                        WHERE id = %s AND status <> 'cancelled'""",
                    (f"{code}: {message}"[:2000], job["id"]),
                )
    return retry


def recover_stale(stale_minutes: int) -> None:
    """Re-queue jobs whose worker stopped heartbeating (crash, OOM, preemption)."""
    with connect() as conn:
        rows = conn.execute(
            """UPDATE processing_jobs
                  SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
                      stage = CASE WHEN attempts >= max_attempts THEN 'Failed' ELSE 'Re-queued after worker loss' END,
                      error_code = 'worker_lost', error_message = 'The processing worker stopped responding',
                      completed_at = CASE WHEN attempts >= max_attempts THEN now() END,
                      locked_by = NULL
                WHERE status IN ('downloading', 'validating', 'extracting_audio', 'transcribing', 'selecting_clips')
                  AND heartbeat_at < now() - make_interval(mins => %s)
            RETURNING id, status, source_video_id""",
            (stale_minutes,),
        ).fetchall()
        for r in rows:
            log.warning("recovered stale analysis job %s -> %s", r["id"], r["status"])
            if r["status"] == "failed":
                conn.execute(
                    "UPDATE source_videos SET status = 'failed' WHERE id = %s AND status = 'processing'",
                    (r["source_video_id"],),
                )
        rows = conn.execute(
            """UPDATE render_jobs
                  SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
                      error_message = 'worker_lost: The render worker stopped responding',
                      completed_at = CASE WHEN attempts >= max_attempts THEN now() END,
                      locked_by = NULL
                WHERE status = 'rendering' AND heartbeat_at < now() - make_interval(mins => %s)
            RETURNING id, status""",
            (stale_minutes,),
        ).fetchall()
        for r in rows:
            log.warning("recovered stale render job %s -> %s", r["id"], r["status"])
        # Publishing: if the worker died before the irreversible call, nothing reached the platform,
        # so the post goes back in the queue (it publishes as soon as a worker runs). After that
        # point it may be live, so it's failed for a human to check: never a silent double post.
        rows = conn.execute(
            """UPDATE publish_jobs
                  SET status = CASE WHEN commit_started_at IS NULL AND attempts < max_attempts
                                    THEN 'queued' ELSE 'failed' END,
                      completed_at = CASE WHEN commit_started_at IS NULL AND attempts < max_attempts
                                          THEN NULL ELSE now() END,
                      locked_by = NULL,
                      error_message = CASE
                        WHEN commit_started_at IS NOT NULL THEN
                          'worker_lost: the worker stopped while the platform was finalising the post; it may or '
                          || 'may not be live — check the platform before retrying'
                        WHEN attempts >= max_attempts THEN
                          'worker_lost: the worker stopped during the upload too many times'
                        ELSE 'Re-queued: the worker stopped before the upload finished (nothing was posted)'
                      END
                WHERE status = 'publishing' AND heartbeat_at < now() - make_interval(mins => %s)
            RETURNING id, status""",
            (stale_minutes,),
        ).fetchall()
        for r in rows:
            log.warning("stale publish job %s -> %s", r["id"], r["status"])


class Heartbeat:
    """Background thread that bumps heartbeat_at while a long stage (e.g. Whisper) runs."""

    def __init__(self, kind: Kind, job_id: str, interval: float):
        self.kind, self.job_id, self.interval = kind, job_id, interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"hb-{job_id[:8]}")

    def _run(self) -> None:
        table = TABLE[self.kind]
        while not self._stop.wait(self.interval):
            try:
                with connect() as conn:
                    conn.execute(f"UPDATE {table} SET heartbeat_at = now() WHERE id = %s", (self.job_id,))
            except Exception:  # never let heartbeat errors kill the job
                log.exception("heartbeat failed for %s", self.job_id)

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
