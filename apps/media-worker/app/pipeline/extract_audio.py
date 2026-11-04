from __future__ import annotations

from pathlib import Path

from .ffmpeg import ProgressFn, run_ffmpeg


def extract_audio(
    input_ref: str,
    out_dir: Path,
    duration_seconds: float,
    on_progress: ProgressFn | None = None,
) -> Path:
    """16 kHz mono 16-bit WAV — the native input format for Whisper (~1.9 MB/min)."""
    out = out_dir / "audio.wav"
    run_ffmpeg(
        ["-i", input_ref, "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)],
        duration_seconds=duration_seconds,
        on_progress=on_progress,
        timeout=max(600, duration_seconds * 2),
        error_code="audio_extraction_failed",
    )
    return out


def encode_compressed_chunk(audio_path: Path, out: Path, start: float, duration: float) -> Path:
    """Low-bitrate mono MP3 chunk for managed speech APIs with upload size limits."""
    run_ffmpeg(
        ["-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(audio_path), "-ac", "1", "-b:a", "48k", str(out)],
        error_code="audio_extraction_failed",
    )
    return out
