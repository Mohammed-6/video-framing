from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from ..config import Settings
from .brand import LogoSpec, MusicSpec, logo_chain, music_chain
from .ffmpeg import ProgressFn, run_ffmpeg
from .reframe import build_framing_graph, crop_filter

if TYPE_CHECKING:
    from .face_track import FramingPlan

CAPTIONS_FILENAME = "captions.ass"


def build_render_args(
    input_ref: str,
    *,
    start: float,
    end: float,
    src_w: int,
    src_h: int,
    crop_center_x: float,
    framing: "FramingPlan | None" = None,
    out_w: int,
    out_h: int,
    with_captions: bool,
    has_audio: bool,
    src_fps: float,
    settings: Settings,
    logo: LogoSpec | None = None,
    music: MusicSpec | None = None,
    crf: int | None = None,
    output_name: str = "output.mp4",
    letterbox_fill: str = "blur",
) -> list[str]:
    """Main clip pass: framing -> captions -> logo, speech (+ music). One filter graph."""
    duration = end - start

    # -ss before -i seeks fast; with re-encoding it is still frame-accurate.
    args = ["-ss", f"{start:.3f}", "-i", input_ref]
    logo_idx = music_idx = None
    next_idx = 1
    if logo:
        logo_idx, next_idx = next_idx, next_idx + 1
        args += ["-i", logo.path]
    if music:
        music_idx, next_idx = next_idx, next_idx + 1
        args += ["-stream_loop", "-1", "-i", music.path]
    args += ["-t", f"{duration:.3f}"]

    # ---- video
    if framing is None:
        graph = [f"[0:v]{crop_filter(src_w, src_h, crop_center_x, out_w, out_h)}[framed]"]
    else:
        g, label = build_framing_graph(framing, src_w, src_h, out_w, out_h, fill=letterbox_fill)
        graph = [g if label == "framed" else f"{g};[{label}]null[framed]"]
    post = []
    if src_fps > 60:
        post.append("fps=60")
    if with_captions:
        # Relative filename: ffmpeg runs with cwd=work_dir, which avoids filter-path escaping.
        post.append(f"ass={CAPTIONS_FILENAME}")
    last = "framed"
    if post:
        graph.append(f"[framed]{','.join(post)}[cap]")
        last = "cap"
    if logo and logo_idx is not None:
        graph.append(logo_chain(logo_idx, last, "branded", logo, out_w, out_h))
        last = "branded"
    graph.append(f"[{last}]format=yuv420p[vout]")

    # ---- audio
    audio_label = None
    if has_audio:
        fade_out_start = max(0.0, duration - 0.12)
        graph.append(
            "[0:a]aresample=48000:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"afade=t=in:d=0.05,afade=t=out:st={fade_out_start:.3f}:d=0.12[speech]"
        )
        audio_label = "speech"
    if music and music_idx is not None:
        graph.append(music_chain(music_idx, duration, music, audio_label, "aout"))
        audio_label = "aout"

    args += ["-filter_complex", ";".join(graph), "-map", "[vout]"]
    args += [
        "-c:v", "libx264",
        "-preset", settings.render_preset,
        "-crf", str(crf if crf is not None else settings.render_crf),
        "-profile:v", "high",
        "-level:v", "4.2",
        "-g", "60",
    ]
    if settings.ffmpeg_threads:
        args += ["-threads", str(settings.ffmpeg_threads)]
    if audio_label:
        args += ["-map", f"[{audio_label}]", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]
    args += ["-movflags", "+faststart", "-map_metadata", "-1", output_name]
    return args


def render_clip(
    input_ref: str,
    work_dir: Path,
    *,
    start: float,
    end: float,
    src_w: int,
    src_h: int,
    src_fps: float,
    crop_center_x: float,
    framing: "FramingPlan | None" = None,
    out_w: int,
    out_h: int,
    ass_content: str | None,
    has_audio: bool,
    settings: Settings,
    logo: LogoSpec | None = None,
    music: MusicSpec | None = None,
    crf: int | None = None,
    output_name: str = "output.mp4",
    letterbox_fill: str = "blur",
    on_progress: ProgressFn | None = None,
) -> Path:
    if ass_content:
        (work_dir / CAPTIONS_FILENAME).write_text(ass_content, encoding="utf-8")
    args = build_render_args(
        input_ref,
        start=start,
        end=end,
        src_w=src_w,
        src_h=src_h,
        crop_center_x=crop_center_x,
        framing=framing,
        out_w=out_w,
        out_h=out_h,
        with_captions=bool(ass_content),
        has_audio=has_audio,
        src_fps=src_fps,
        settings=settings,
        logo=logo,
        music=music,
        crf=crf,
        output_name=output_name,
        letterbox_fill=letterbox_fill,
    )
    run_ffmpeg(
        args,
        cwd=work_dir,
        duration_seconds=end - start,
        on_progress=on_progress,
        timeout=max(900, (end - start) * 20),
        error_code="render_failed",
    )
    return work_dir / output_name
