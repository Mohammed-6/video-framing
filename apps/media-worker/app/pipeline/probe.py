from __future__ import annotations

from dataclasses import dataclass

from ..errors import PipelineError
from .ffmpeg import ffprobe_json


@dataclass(frozen=True)
class MediaInfo:
    duration_seconds: float
    width: int  # display width (after rotation metadata is applied)
    height: int
    fps: float
    video_codec: str
    has_audio: bool
    rotation: int


def _parse_fps(rate: str | None) -> float:
    if not rate or rate in ("0/0", "0"):
        return 0.0
    if "/" in rate:
        num, den = rate.split("/", 1)
        return float(num) / float(den) if float(den) else 0.0
    return float(rate)


def _rotation(stream: dict) -> int:
    rot = 0
    tags = stream.get("tags") or {}
    if "rotate" in tags:
        try:
            rot = int(tags["rotate"])
        except ValueError:
            rot = 0
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    return abs(rot) % 360


def parse_probe(data: dict) -> MediaInfo:
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video" and not _is_cover_art(s)), None)
    if video is None:
        raise PipelineError("no_video_stream", "The file does not contain a video stream")
    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    duration = 0.0
    for candidate in ((data.get("format") or {}).get("duration"), video.get("duration")):
        try:
            duration = float(candidate)
            if duration > 0:
                break
        except (TypeError, ValueError):
            continue
    if duration <= 0:
        raise PipelineError("unknown_duration", "Could not determine the video duration")

    w, h = int(video.get("width") or 0), int(video.get("height") or 0)
    rotation = _rotation(video)
    # ffmpeg auto-rotates on decode, so downstream filters see the display orientation.
    if rotation in (90, 270):
        w, h = h, w
    if w <= 0 or h <= 0:
        raise PipelineError("invalid_dimensions", "Could not determine the video dimensions")

    fps = _parse_fps(video.get("avg_frame_rate")) or _parse_fps(video.get("r_frame_rate"))
    return MediaInfo(
        duration_seconds=duration,
        width=w,
        height=h,
        fps=round(fps, 3),
        video_codec=str(video.get("codec_name") or "unknown"),
        has_audio=has_audio,
        rotation=rotation,
    )


def _is_cover_art(stream: dict) -> bool:
    return bool((stream.get("disposition") or {}).get("attached_pic"))


def probe(input_ref: str) -> MediaInfo:
    return parse_probe(ffprobe_json(input_ref))
