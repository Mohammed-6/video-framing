"""Thin, safe wrappers around the ffmpeg/ffprobe CLIs (argument lists only — never a shell)."""

from __future__ import annotations

import json
import subprocess
import threading
from collections import deque
from pathlib import Path
from typing import Callable, Sequence

from ..errors import PipelineError

ProgressFn = Callable[[float], None]


def run_ffmpeg(
    args: Sequence[str],
    *,
    duration_seconds: float | None = None,
    on_progress: ProgressFn | None = None,
    cwd: Path | None = None,
    timeout: float | None = None,
    error_code: str = "ffmpeg_failed",
) -> None:
    """Run ffmpeg, reporting progress as a 0..1 fraction parsed from `-progress pipe:1`."""
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", *args]
    stderr_tail: deque[str] = deque(maxlen=30)
    try:
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace"
        )
    except FileNotFoundError as exc:
        raise PipelineError("ffmpeg_missing", "ffmpeg is not installed on the worker") from exc

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_tail.append(line.rstrip())

    t = threading.Thread(target=drain_stderr, daemon=True)
    t.start()

    assert proc.stdout is not None
    last_reported = -1.0
    try:
        for line in proc.stdout:
            if not on_progress or not duration_seconds or not line.startswith("out_time_us="):
                continue
            try:
                us = int(line.split("=", 1)[1])
            except ValueError:
                continue
            frac = max(0.0, min(1.0, us / 1_000_000 / duration_seconds))
            if frac - last_reported >= 0.01:
                last_reported = frac
                on_progress(frac)  # may raise JobCancelled
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise PipelineError("ffmpeg_timeout", "Media processing timed out", retryable=True)
    t.join(timeout=5)
    if code != 0:
        detail = "\n".join(stderr_tail)[-1500:]
        raise PipelineError(error_code, f"ffmpeg exited with {code}: {detail}")


def ffprobe_json(input_ref: str, timeout: float = 120) -> dict:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        input_ref,
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise PipelineError("ffmpeg_missing", "ffprobe is not installed on the worker") from exc
    except subprocess.TimeoutExpired as exc:
        raise PipelineError("probe_timeout", "Timed out reading the video", retryable=True) from exc
    if res.returncode != 0:
        raise PipelineError("unreadable_media", f"Could not read the video file: {res.stderr.strip()[-500:]}")
    return json.loads(res.stdout or "{}")
