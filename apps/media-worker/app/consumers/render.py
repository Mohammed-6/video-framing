"""Render job: crop/reframe to 9:16, burn styled captions + watermark, QC, upload."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from psycopg.types.json import Jsonb

from ..config import Settings
from ..db import connect
from ..errors import JobCancelled, PipelineError
from ..models import Transcript, TranscriptSegment
from ..pipeline.brand import ConcatPart, LogoSpec, MusicSpec, build_concat_args
from ..pipeline.captions import build_ass, relative_words
from ..pipeline.ffmpeg import run_ffmpeg
from ..pipeline.face_track import (
    fixed_plan,
    needs_tracking,
    plan_to_json,
    tight_width,
    track_and_plan,
    zoom_to_width,
)
from ..pipeline.probe import probe
from ..pipeline.quality_check import check_output
from ..pipeline.render import render_clip
from ..storage import Storage
from . import jobqueue
from .progress import StageProgress

log = logging.getLogger(__name__)


def _parse_resolution(res: str) -> tuple[int, int]:
    try:
        w, h = (int(x) for x in res.lower().split("x", 1))
    except ValueError as exc:
        raise PipelineError("invalid_resolution", f"Invalid resolution {res!r}") from exc
    if w % 2 or h % 2 or not (240 <= w <= 2160 and 240 <= h <= 3840):
        raise PipelineError("invalid_resolution", f"Unsupported resolution {res!r}")
    return w, h


def _load_transcript(clip_id: str) -> Transcript | None:
    with connect() as conn:
        row = conn.execute(
            """SELECT t.language, t.provider, t.transcript_json
                 FROM transcripts t JOIN clips c ON c.source_video_id = t.source_video_id
                WHERE c.id = %s ORDER BY t.created_at DESC LIMIT 1""",
            (clip_id,),
        ).fetchone()
    if not row:
        return None
    segments = [TranscriptSegment.model_validate(s) for s in (row["transcript_json"] or {}).get("segments", [])]
    return Transcript(language=row["language"], provider=row["provider"], segments=segments)


def process_render(job: dict, settings: Settings, storage: Storage) -> None:
    job_id = str(job["id"])
    opts: dict = job.get("options") or {}
    start, end = float(opts["startSeconds"]), float(opts["endSeconds"])
    out_w, out_h = _parse_resolution(job["resolution"])
    brand: dict = opts.get("brand") or {}
    style = job["caption_style"]
    kit: dict = opts.get("brandKit") or {}
    two_pass = bool(kit.get("intro") or kit.get("outro"))
    progress = StageProgress("render", job_id, 15, 78 if two_pass else 90)

    work_dir = Path(settings.work_dir) / f"render-{job_id}"
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        with jobqueue.Heartbeat("render", job_id, settings.heartbeat_interval_seconds):
            src = storage.input_ref(opts["sourceBlobKey"], work_dir)
            info = probe(src)
            end = min(end, info.duration_seconds)
            if end - start < 1:
                raise PipelineError("invalid_clip_bounds", "Clip is outside the source video")
            jobqueue.set_progress("render", job_id, 3)

            # Framing: follow faces (auto) and/or zoom out (up to a letterboxed full frame).
            crop_cx = float(opts.get("cropCenterX", 0.5))
            zoom = float(opts.get("cropZoom") or 0.0)
            framing = None
            if needs_tracking(info.width, info.height, out_w, out_h):
                if opts.get("reframeMode") == "auto":
                    try:
                        plan, faces_seen = track_and_plan(
                            src, start, end, info.width, info.height, out_w, out_h,
                            fallback_cx=crop_cx,
                            model_path=settings.face_model_path,
                            multi_face=opts.get("multiFace", "group"),
                            steady=opts.get("steadyZoom", True) is not False,
                            on_progress=StageProgress("render", job_id, 3, 15),
                        )
                        if faces_seen:
                            framing = plan
                    except JobCancelled:
                        raise
                    except Exception:  # framing is an enhancement; never fail the render over it
                        log.exception("face tracking failed for render %s; using fixed crop", job_id)
                if framing is None and zoom > 0.001:
                    tight = tight_width(info.width, info.height, out_w, out_h)
                    framing = fixed_plan(end - start, crop_cx, zoom_to_width(zoom, tight))
            track_json = plan_to_json(framing) if framing is not None else None

            ass = None
            watermark = (brand.get("watermarkText") or "").strip() or None
            if style != "none" or watermark:
                transcript = _load_transcript(str(job["clip_id"]))
                words = relative_words(transcript.words_between(start, end), start, end) if transcript else []
                ass = build_ass(
                    words,
                    clip_duration=end - start,
                    style=style,
                    width=out_w,
                    height=out_h,
                    font=settings.caption_font,
                    highlight_color=brand.get("primaryColor"),
                    position=brand.get("captionPosition", "bottom"),
                    watermark=watermark,
                )

            # Brand kit files (small) are fetched locally.
            def asset(part: str) -> str | None:
                spec = kit.get(part)
                return str(storage.local_file(spec["blobKey"], work_dir)) if spec else None

            logo_path, music_path = asset("logo"), asset("music")
            logo = (
                LogoSpec(logo_path, kit["logo"].get("position", "top-left"), float(kit["logo"].get("scale", 0.18)),
                         float(kit["logo"].get("opacity", 0.9)))
                if logo_path else None
            )
            music = (
                MusicSpec(music_path, float(kit["music"].get("volume", 0.15)), bool(kit["music"].get("duck", True)))
                if music_path else None
            )

            output = render_clip(
                src,
                work_dir,
                start=start,
                end=end,
                src_w=info.width,
                src_h=info.height,
                src_fps=info.fps,
                crop_center_x=crop_cx,
                framing=framing,
                out_w=out_w,
                out_h=out_h,
                ass_content=ass,
                has_audio=info.has_audio,
                settings=settings,
                logo=logo,
                # With an intro/outro the music goes under the whole joined video instead.
                music=None if two_pass else music,
                # The main pass is re-encoded once more when joined: keep it near-lossless.
                crf=max(10, settings.render_crf - 6) if two_pass else None,
                output_name="main.mp4" if two_pass else "output.mp4",
                letterbox_fill=opts.get("letterboxFill", "blur"),
                on_progress=progress,
            )
            expected = end - start
            expect_audio = info.has_audio or music is not None
            if two_pass:
                parts: list[ConcatPart] = []
                for name in ("intro", "main", "outro"):
                    path = str(output) if name == "main" else asset(name)
                    if not path:
                        continue
                    p_info = probe(path)
                    parts.append(ConcatPart(path, p_info.duration_seconds, p_info.has_audio))
                # Joined video runs at the clip's frame rate, but never below 24 fps (keeps intros smooth).
                main_fps = min(60.0, max(24.0, probe(str(output)).fps or 30.0))
                run_ffmpeg(
                    build_concat_args(parts, out_w=out_w, out_h=out_h, fps=main_fps, music=music, settings=settings,
                                      output_name="output.mp4"),
                    cwd=work_dir,
                    duration_seconds=sum(p.duration for p in parts),
                    on_progress=StageProgress("render", job_id, 78, 92),
                    timeout=1800,
                    error_code="render_failed",
                )
                output = work_dir / "output.mp4"
                expected = sum(p.duration for p in parts)
                expect_audio = True
            qc = check_output(
                output, expected_w=out_w, expected_h=out_h, expected_duration=expected, expect_audio=expect_audio
            )
            jobqueue.set_progress("render", job_id, 93)
            if jobqueue.is_cancelled("render", job_id):
                raise JobCancelled()
            storage.upload_file(output, job["output_blob_key"], "video/mp4")
            _persist_output(job, qc, track_json)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _persist_output(job: dict, qc, track_json: list | None = None) -> None:
    opts = job.get("options") or {}
    with connect(autocommit=False) as conn:
        with conn.transaction():
            conn.execute(
                """INSERT INTO clip_outputs (render_job_id, blob_key, file_size_bytes, duration_seconds, width, height, codec)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (render_job_id) DO UPDATE
                     SET blob_key = EXCLUDED.blob_key, file_size_bytes = EXCLUDED.file_size_bytes,
                         duration_seconds = EXCLUDED.duration_seconds, width = EXCLUDED.width,
                         height = EXCLUDED.height, codec = EXCLUDED.codec""",
                (job["id"], job["output_blob_key"], qc.file_size_bytes, qc.duration_seconds, qc.width, qc.height, qc.codec),
            )
            conn.execute(
                """UPDATE render_jobs SET status = 'completed', progress_percent = 100, completed_at = now(),
                          locked_by = NULL, error_message = NULL, reframe_track = %s
                    WHERE id = %s""",
                (Jsonb(track_json) if track_json else None, job["id"]),
            )
            # Only mark the clip "rendered" if it wasn't edited while this render ran
            # (otherwise the render is stale and the clip stays "edited").
            conn.execute(
                """UPDATE clips SET status = 'rendered', updated_at = now()
                    WHERE id = %s AND status IN ('candidate', 'edited')
                      AND abs(start_seconds - %s) < 0.001 AND abs(end_seconds - %s) < 0.001
                      AND abs(crop_center_x - %s) < 0.0001 AND reframe_mode = %s
                      AND abs(crop_zoom - %s) < 0.0001""",
                (
                    job["clip_id"],
                    float(opts.get("startSeconds", -1)),
                    float(opts.get("endSeconds", -1)),
                    float(opts.get("cropCenterX", 0.5)),
                    opts.get("reframeMode", "fixed"),
                    float(opts.get("cropZoom") or 0.0),
                ),
            )
