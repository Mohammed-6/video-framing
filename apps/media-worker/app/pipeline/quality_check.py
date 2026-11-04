"""Verify a rendered file before we hand it to a user or a platform."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..errors import PipelineError
from .ffmpeg import ffprobe_json


@dataclass(frozen=True)
class OutputInfo:
    file_size_bytes: int
    duration_seconds: float
    width: int
    height: int
    codec: str


# Platform constraints that matter for 9:16 shorts (conservative intersection).
MAX_SHORTS_SECONDS = 180.0
MAX_FILE_BYTES = 1024**3


def check_output(path: Path, *, expected_w: int, expected_h: int, expected_duration: float, expect_audio: bool) -> OutputInfo:
    if not path.exists() or path.stat().st_size == 0:
        raise PipelineError("qc_empty_output", "Render produced no output", retryable=True)
    data = ffprobe_json(str(path))
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video:
        raise PipelineError("qc_no_video", "Rendered file has no video stream")
    w, h = int(video.get("width", 0)), int(video.get("height", 0))
    if (w, h) != (expected_w, expected_h):
        raise PipelineError("qc_dimensions", f"Expected {expected_w}x{expected_h}, got {w}x{h}")
    if video.get("codec_name") != "h264" or video.get("pix_fmt") != "yuv420p":
        raise PipelineError("qc_codec", f"Unexpected codec {video.get('codec_name')}/{video.get('pix_fmt')}")
    if expect_audio and not any(s.get("codec_type") == "audio" for s in streams):
        raise PipelineError("qc_no_audio", "Rendered file is missing its audio track")
    duration = float((data.get("format") or {}).get("duration") or 0)
    if abs(duration - expected_duration) > 0.6:
        raise PipelineError("qc_duration", f"Expected ~{expected_duration:.2f}s, got {duration:.2f}s")
    if duration > MAX_SHORTS_SECONDS + 0.5:
        raise PipelineError("qc_too_long", "Clip exceeds the 180s limit for short-form platforms")
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise PipelineError("qc_too_large", "Rendered file exceeds 1 GB")
    return OutputInfo(file_size_bytes=size, duration_seconds=round(duration, 3), width=w, height=h, codec="h264")
