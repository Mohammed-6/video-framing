"""Pipeline job: [download] -> probe -> extract audio -> transcribe -> scenes -> select clips -> auto-render."""

from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path

from psycopg.types.json import Jsonb

from ..config import Settings
from ..db import connect
from ..errors import JobCancelled, PipelineError
from ..pipeline.detect_scenes import detect_scenes
from ..pipeline.download import download_youtube
from ..pipeline.extract_audio import extract_audio
from ..pipeline.probe import MediaInfo, probe
from ..pipeline.select_clips import SelectionParams, select_clips
from ..pipeline.transcribe import transcribe
from ..storage import Storage
from . import jobqueue
from .brand import resolve_brand_kit
from .progress import StageProgress

log = logging.getLogger(__name__)

DEFAULT_RENDER = {"captionStyle": "bold_pop", "resolution": "1080x1920", "brand": {"captionPosition": "bottom"}}


def _load_video(video_id: str) -> dict:
    with connect() as conn:
        row = conn.execute("SELECT * FROM source_videos WHERE id = %s", (video_id,)).fetchone()
    if not row:
        raise PipelineError("source_missing", "The source video no longer exists")
    return row


def load_app_settings() -> dict:
    with connect() as conn:
        row = conn.execute("SELECT settings FROM app_settings LIMIT 1").fetchone()
    return (row or {}).get("settings") or {}


def _download(job_id: str, video: dict, work_dir: Path, settings: Settings, storage: Storage) -> str:
    """Fetch a YouTube source into storage. Returns a local path ffmpeg can read."""
    jobqueue.set_stage(job_id, "downloading", "Downloading from YouTube", 1)
    result = download_youtube(
        video["youtube_video_id"], work_dir, settings, StageProgress("analysis", job_id, 1, 12)
    )
    key = f"sources/{video['id']}/source{result.path.suffix or '.mp4'}"
    storage.upload_file(result.path, key, "video/mp4")
    with connect() as conn:
        conn.execute(
            """UPDATE source_videos
                  SET blob_key = %s, mime_type = 'video/mp4', file_size_bytes = %s,
                      title = CASE WHEN title LIKE 'YouTube video %%' THEN COALESCE(%s::text, title) ELSE title END,
                      channel_title = COALESCE(channel_title, %s::text), channel_id = COALESCE(channel_id, %s::text),
                      license = COALESCE(license, %s::text), thumbnail_url = COALESCE(thumbnail_url, %s::text)
                WHERE id = %s""",
            (
                key, result.path.stat().st_size, result.title,
                result.channel, result.channel_id, result.license, result.thumbnail_url, video["id"],
            ),
        )
    video["blob_key"] = key
    return str(result.path)


def process_analysis(job: dict, settings: Settings, storage: Storage) -> None:
    job_id = str(job["id"])
    params = job.get("params") or {}
    selection = SelectionParams(
        target_clip_count=int(params.get("targetClipCount", 5)),
        min_duration=float(params.get("minDurationSeconds", 20)),
        max_duration=float(params.get("maxDurationSeconds", 60)),
    )
    video = _load_video(str(job["source_video_id"]))
    work_dir = Path(settings.work_dir) / f"analysis-{job_id}"
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        with jobqueue.Heartbeat("analysis", job_id, settings.heartbeat_interval_seconds):
            # 0. downloading (YouTube imports that haven't been fetched yet)
            if not video["blob_key"]:
                if video["origin"] != "youtube" or not video["youtube_video_id"]:
                    raise PipelineError("source_missing", "This video has no file to process")
                src = _download(job_id, video, work_dir, settings, storage)
            else:
                src = storage.input_ref(video["blob_key"], work_dir)

            # 1. validating
            jobqueue.set_stage(job_id, "validating", "Checking the video", 12)
            info = probe(src)
            if not info.has_audio:
                raise PipelineError("no_audio", "The video has no audio track, so it can't be transcribed")
            if info.duration_seconds > settings.max_source_minutes * 60:
                raise PipelineError("source_too_long", f"Videos longer than {settings.max_source_minutes} minutes aren't supported")
            with connect() as conn:
                conn.execute(
                    "UPDATE source_videos SET duration_seconds = %s, width = %s, height = %s, fps = %s WHERE id = %s",
                    (info.duration_seconds, info.width, info.height, info.fps, video["id"]),
                )

            # 2. extracting_audio (13 -> 20%)
            jobqueue.set_stage(job_id, "extracting_audio", "Extracting audio", 13)
            audio = extract_audio(src, work_dir, info.duration_seconds, StageProgress("analysis", job_id, 13, 20))

            # 3. transcribing (20 -> 75%)
            jobqueue.set_stage(job_id, "transcribing", "Transcribing speech", 20)
            transcript = transcribe(
                audio, info.duration_seconds, params.get("language"), settings, StageProgress("analysis", job_id, 20, 75)
            )
            with connect() as conn:
                conn.execute(
                    """INSERT INTO transcripts (source_video_id, language, provider, transcript_json)
                       VALUES (%s, %s, %s, %s)""",
                    (video["id"], transcript.language, transcript.provider, Jsonb(transcript.to_storage_json())),
                )

            # 4. selecting_clips (78 -> 95%)
            jobqueue.set_stage(job_id, "selecting_clips", "Finding the most engaging moments", 78)
            cuts = detect_scenes(src, info.duration_seconds, settings.scene_threshold) if settings.scene_detection else []
            jobqueue.set_progress("analysis", job_id, 86)
            clips, planner = select_clips(transcript.segments, info.duration_seconds, selection, settings, cuts)
            log.info("job %s: %d clips via %s planner", job_id, len(clips), planner)

            _persist_results(job_id, video, info, clips, planner, load_app_settings())
    except JobCancelled:
        log.info("analysis job %s cancelled", job_id)
        raise
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def reframe_mode(app_settings: dict) -> str:
    """New clips follow the speaker unless the default is set to a fixed centre crop."""
    return "fixed" if (app_settings.get("render") or {}).get("reframe") == "center" else "auto"


def build_render_snapshot(app_settings: dict, video: dict, info: MediaInfo, clip) -> dict:
    """Mirror of RenderSnapshot in apps/api/src/queue/index.ts."""
    render = {**DEFAULT_RENDER, **(app_settings.get("render") or {})}
    include = render.get("include") or {}
    captions_on = include.get("captions", True) is not False
    return {
        "aspectRatio": "9:16",
        "captionStyle": render.get("captionStyle", "bold_pop") if captions_on else "none",
        "resolution": render.get("resolution", "1080x1920"),
        "brand": render.get("brand") or {"captionPosition": "bottom"},
        "sourceBlobKey": video["blob_key"],
        "sourceWidth": info.width,
        "sourceHeight": info.height,
        "startSeconds": clip.startSeconds,
        "endSeconds": clip.endSeconds,
        "cropCenterX": 0.5,
        "reframeMode": reframe_mode(app_settings),
        "cropZoom": 0.0,
        "multiFace": render.get("multiFace", "group"),
        "steadyZoom": render.get("steadyZoom", True) is not False,
        "letterboxFill": render.get("letterboxFill", "blur"),
        "brandKit": resolve_brand_kit(render.get("brandKit") or {}, include),
        "title": clip.title,
    }


def _persist_results(job_id: str, video: dict, info: MediaInfo, clips, planner: str, app_settings: dict) -> None:
    auto_render = app_settings.get("autoRender", True) is not False
    with connect(autocommit=False) as conn:
        with conn.transaction():
            row = conn.execute("SELECT status FROM processing_jobs WHERE id = %s FOR UPDATE", (job_id,)).fetchone()
            if not row or row["status"] == "cancelled":
                raise JobCancelled()
            # Re-analysis replaces untouched suggestions; keeps edited/rendered/published clips.
            conn.execute(
                """DELETE FROM clips c WHERE c.source_video_id = %s AND c.status = 'candidate'
                     AND NOT EXISTS (SELECT 1 FROM publish_jobs p WHERE p.clip_id = c.id)""",
                (video["id"],),
            )
            renders = 0
            for c in clips:
                clip_id = conn.execute(
                    """INSERT INTO clips (source_video_id, processing_job_id, start_seconds, end_seconds,
                                          title, hook, selection_reason, score, reframe_mode)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (
                        video["id"], job_id, c.startSeconds, c.endSeconds, c.title, c.hook or None,
                        c.reason or None, c.score, reframe_mode(app_settings),
                    ),
                ).fetchone()["id"]
                if auto_render:
                    snap = build_render_snapshot(app_settings, video, info, c)
                    render_id = uuid.uuid4()
                    conn.execute(
                        """INSERT INTO render_jobs (id, clip_id, aspect_ratio, caption_style, resolution, options, output_blob_key)
                           VALUES (%s, %s, '9:16', %s, %s, %s, %s)""",
                        (render_id, clip_id, snap["captionStyle"], snap["resolution"], Jsonb(snap), f"renders/{render_id}.mp4"),
                    )
                    renders += 1
            stage = f"{len(clips)} clips found ({planner})" + (f", {renders} rendering" if renders else "")
            conn.execute(
                """UPDATE processing_jobs
                      SET status = 'clips_ready', stage = %s, progress_percent = 100, completed_at = now(), locked_by = NULL
                    WHERE id = %s""",
                (stage, job_id),
            )
            conn.execute("UPDATE source_videos SET status = 'ready' WHERE id = %s", (video["id"],))
