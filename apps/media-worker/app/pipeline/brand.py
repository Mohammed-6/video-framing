"""Brand kit in ffmpeg terms: logo overlay, background music (with ducking), intro/outro join.

Render passes:
  1. main clip: framing + captions + logo (+ music when there's no intro/outro)
  2. only when an intro or outro is used: normalise every part to the output size/fps/audio
     format, concatenate, and lay the music under the whole thing.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import Settings


@dataclass(frozen=True)
class LogoSpec:
    path: str
    position: str = "top-left"  # top-left | top-right | bottom-left | bottom-right
    scale: float = 0.18  # logo width / video width
    opacity: float = 0.9


@dataclass(frozen=True)
class MusicSpec:
    path: str
    volume: float = 0.15
    duck: bool = True


@dataclass(frozen=True)
class ConcatPart:
    path: str
    duration: float
    has_audio: bool


AUDIO_FMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"


def _even(n: float) -> int:
    return max(2, int(n) // 2 * 2)


def logo_chain(input_idx: int, in_label: str, out_label: str, spec: LogoSpec, out_w: int, out_h: int) -> str:
    width = _even(out_w * min(0.5, max(0.05, spec.scale)))
    mx = int(out_w * 0.05)
    my_top = int(out_h * 0.04)
    my_bottom = int(out_h * 0.06)
    x = str(mx) if spec.position.endswith("left") else f"main_w-overlay_w-{mx}"
    y = str(my_top) if spec.position.startswith("top") else f"main_h-overlay_h-{my_bottom}"
    opacity = min(1.0, max(0.0, spec.opacity))
    return (
        f"[{input_idx}:v]scale={width}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa={opacity:.2f}[logo];"
        f"[{in_label}][logo]overlay=x={x}:y={y}:format=auto[{out_label}]"
    )


def music_chain(input_idx: int, duration: float, spec: MusicSpec, speech_label: str | None, out_label: str) -> str:
    """Loop/trim the track to `duration`, fade it, and mix it under the speech (ducked)."""
    volume = min(1.0, max(0.0, spec.volume))
    fade_out = max(0.0, duration - 1.5)
    music = (
        f"[{input_idx}:a]{AUDIO_FMT},volume={volume:.3f},atrim=0:{duration:.3f},asetpts=N/SR/TB,"
        f"afade=t=in:d=1,afade=t=out:st={fade_out:.3f}:d=1.5"
    )
    if speech_label is None:
        return f"{music}[{out_label}]"
    if spec.duck:
        # Speech drives a compressor on the music: it dips while someone talks.
        return (
            f"{music}[mus];[{speech_label}]asplit=2[sp][sc];"
            f"[mus][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=450[duck];"
            f"[sp][duck]amix=inputs=2:duration=first:normalize=0[{out_label}]"
        )
    return f"{music}[mus];[{speech_label}][mus]amix=inputs=2:duration=first:normalize=0[{out_label}]"


def build_concat_args(
    parts: list[ConcatPart],
    *,
    out_w: int,
    out_h: int,
    fps: float,
    music: MusicSpec | None,
    settings: Settings,
    output_name: str = "output.mp4",
) -> list[str]:
    """Intro + clip + outro -> one out_w x out_h video. Every part gets a matching audio track."""
    args: list[str] = []
    for p in parts:
        args += ["-i", p.path]
    music_idx = None
    if music:
        music_idx = len(parts)
        args += ["-stream_loop", "-1", "-i", music.path]

    fps_s = f"{fps:.3f}".rstrip("0").rstrip(".") if fps > 0 else "30"
    graph: list[str] = []
    for i, p in enumerate(parts):
        graph.append(
            f"[{i}:v]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={fps_s},format=yuv420p,"
            f"trim=0:{p.duration:.3f},setpts=PTS-STARTPTS[v{i}]"
        )
        if p.has_audio:
            # apad+atrim: audio exactly as long as the video so the parts stay in sync.
            graph.append(f"[{i}:a]{AUDIO_FMT},apad,atrim=0:{p.duration:.3f},asetpts=N/SR/TB[a{i}]")
        else:
            graph.append(f"anullsrc=r=48000:cl=stereo,{AUDIO_FMT},atrim=0:{p.duration:.3f}[a{i}]")
    graph.append("".join(f"[v{i}][a{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=1:a=1[vout][acat]")
    total = sum(p.duration for p in parts)
    if music and music_idx is not None:
        graph.append(music_chain(music_idx, total, music, "acat", "aout"))
        audio_label = "aout"
    else:
        audio_label = "acat"

    args += ["-filter_complex", ";".join(graph), "-map", "[vout]", "-map", f"[{audio_label}]"]
    args += [
        "-c:v", "libx264", "-preset", settings.render_preset, "-crf", str(settings.render_crf),
        "-profile:v", "high", "-level:v", "4.2", "-g", "60",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", "-map_metadata", "-1", output_name,
    ]
    return args
