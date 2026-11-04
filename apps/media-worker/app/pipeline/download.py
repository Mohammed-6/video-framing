"""Import a YouTube video with yt-dlp.

Note: the YouTube Data API does not offer downloads; yt-dlp works against YouTube's
Terms of Service. You are responsible for having the rights to the videos you import.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from ..config import Settings
from ..errors import JobCancelled, PipelineError

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class DownloadResult:
    path: Path
    title: str | None
    channel: str | None
    channel_id: str | None
    duration_seconds: float | None
    license: str | None
    thumbnail_url: str | None


def classify_error(message: str) -> PipelineError:
    m = message.lower()
    if "confirm you" in m and "bot" in m or "sign in to confirm" in m:
        return PipelineError(
            "youtube_bot_check",
            "YouTube blocked the download with a bot check. Export your browser's YouTube cookies to a file and set "
            "YTDLP_COOKIES_FILE on the worker.",
        )
    if "private video" in m or "video unavailable" in m or "has been removed" in m or "members-only" in m:
        return PipelineError("video_unavailable", "The video is private, removed or otherwise unavailable")
    if "age" in m and ("restricted" in m or "confirm your age" in m):
        return PipelineError("age_restricted", "Age-restricted video: set YTDLP_COOKIES_FILE from a signed-in browser")
    if "live event" in m or "is live" in m or "premieres in" in m:
        return PipelineError("live_video", "Live or upcoming streams can't be imported until they finish")
    if "http error 5" in m or "timed out" in m or "connection" in m or "temporary" in m:
        return PipelineError("download_failed", message[-500:], retryable=True)
    return PipelineError("download_failed", message[-500:], retryable=True)


def build_options(work_dir: Path, settings: Settings, hook: Callable[[dict], None]) -> dict:
    h = settings.ytdlp_max_height
    opts: dict = {
        # Prefer H.264/AAC MP4 at <= max height; fall back to anything we can merge into MP4.
        "format": (
            f"bv*[height<={h}][vcodec^=avc1]+ba[ext=m4a]/"
            f"bv*[height<={h}][ext=mp4]+ba[ext=m4a]/"
            f"bv*[height<={h}]+ba/b[height<={h}]/b"
        ),
        "merge_output_format": "mp4",
        "outtmpl": str(work_dir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 5,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 4,
        "progress_hooks": [hook],
        "match_filter": _reject_live_and_long(settings.max_source_minutes),
    }
    if settings.ytdlp_cookies_file:
        opts["cookiefile"] = settings.ytdlp_cookies_file
    return opts


def _reject_live_and_long(max_minutes: int):
    def check(info: dict, *, incomplete: bool = False) -> str | None:
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
            return "live event"
        duration = info.get("duration")
        if duration and duration > max_minutes * 60:
            return f"longer than {max_minutes} minutes"
        return None

    return check


def download_youtube(
    video_id: str,
    work_dir: Path,
    settings: Settings,
    on_progress: Callable[[float], None] | None = None,
) -> DownloadResult:
    try:
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import DownloadError
    except ImportError as exc:  # pragma: no cover
        raise PipelineError("downloader_missing", "yt-dlp is not installed on the worker") from exc

    cancelled: list[JobCancelled] = []

    def hook(d: dict) -> None:
        if d.get("status") != "downloading" or not on_progress:
            return
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        if total:
            try:
                on_progress(min(1.0, d.get("downloaded_bytes", 0) / total))
            except JobCancelled as exc:
                cancelled.append(exc)
                raise

    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        with YoutubeDL(build_options(work_dir, settings, hook)) as ydl:
            info = ydl.extract_info(url, download=True)
    except DownloadError as exc:
        if cancelled:
            raise cancelled[0] from exc
        msg = str(exc)
        if "does not pass filter" in msg:
            reason = msg.split("does not pass filter", 1)[-1].strip(" ():,")
            raise PipelineError("source_rejected", f"Video skipped: {reason or 'filtered'}") from exc
        raise classify_error(msg) from exc
    if cancelled:
        raise cancelled[0]
    if not info:
        raise PipelineError("download_failed", "yt-dlp returned no video information")

    files = sorted(work_dir.glob("source.*"), key=lambda p: p.stat().st_size, reverse=True)
    files = [f for f in files if f.suffix not in (".part", ".ytdl") and not f.name.endswith(".part")]
    if not files:
        raise PipelineError("download_failed", "Download finished but no media file was produced", retryable=True)
    path = next((f for f in files if f.suffix == ".mp4"), files[0])
    log.info("downloaded %s -> %s (%d bytes)", video_id, path.name, path.stat().st_size)
    return DownloadResult(
        path=path,
        title=info.get("title"),
        channel=info.get("channel") or info.get("uploader"),
        channel_id=info.get("channel_id"),
        duration_seconds=float(info["duration"]) if info.get("duration") else None,
        license=info.get("license"),
        thumbnail_url=info.get("thumbnail"),
    )
