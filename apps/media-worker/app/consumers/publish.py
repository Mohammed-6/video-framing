"""Publish job: upload a rendered clip to one platform (YouTube Shorts, Facebook Reels, Instagram Reels)."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from ..config import Settings
from ..crypto import decrypt_credentials
from ..db import connect
from ..errors import JobCancelled, PipelineError
from ..publishers import PublishContext, PublishError, get_publisher
from ..storage import Storage
from . import jobqueue
from .progress import StageProgress

log = logging.getLogger(__name__)


def _load(job: dict) -> tuple[dict, dict]:
    with connect() as conn:
        account = conn.execute("SELECT * FROM platform_accounts WHERE platform = %s", (job["platform"],)).fetchone()
        output = conn.execute(
            """SELECT o.blob_key, r.status FROM render_jobs r JOIN clip_outputs o ON o.render_job_id = r.id
                WHERE r.id = %s""",
            (job["render_job_id"],),
        ).fetchone()
    if not account:
        raise PipelineError("unknown_platform", f"Unknown platform {job['platform']}")
    if not output or output["status"] != "completed":
        raise PipelineError("render_missing", "The rendered video for this post no longer exists")
    return account, output


def process_publish(job: dict, settings: Settings, storage: Storage) -> None:
    job_id = str(job["id"])
    account, output = _load(job)
    if not account["enabled"]:
        raise PublishError("platform_disabled", f"{job['platform']} is disabled in Settings")
    credentials = decrypt_credentials(account["credentials"], settings.credentials_key)

    work_dir = Path(settings.work_dir) / f"publish-{job_id}"
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        with jobqueue.Heartbeat("publish", job_id, settings.heartbeat_interval_seconds):
            if jobqueue.is_cancelled("publish", job_id):
                raise JobCancelled()
            video_path = storage.local_file(output["blob_key"], work_dir)
            ctx = PublishContext(
                video_path=video_path,
                title=job["title"],
                description=job["description"] or "",
                config=account["config"] or {},
                credentials=credentials,
                settings=settings,
                on_progress=StageProgress("publish", job_id, 2, 99, min_interval=1.0),
                on_commit=lambda: jobqueue.mark_commit(job_id),
            )
            try:
                result = get_publisher(job["platform"], settings).publish(ctx)
            finally:
                if ctx.client is not None:
                    ctx.client.close()

        with connect(autocommit=False) as conn:
            with conn.transaction():
                conn.execute(
                    """UPDATE publish_jobs SET status = 'published', progress_percent = 100, external_id = %s,
                              external_url = %s, completed_at = now(), locked_by = NULL, error_message = NULL
                        WHERE id = %s""",
                    (result.external_id, result.url, job_id),
                )
                conn.execute(
                    "UPDATE clips SET status = 'published', updated_at = now() WHERE id = %s AND status <> 'discarded'",
                    (job["clip_id"],),
                )
        log.info("published clip %s to %s: %s", job["clip_id"], job["platform"], result.url)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
