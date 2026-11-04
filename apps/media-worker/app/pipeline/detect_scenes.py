"""Shot-boundary detection using ffmpeg's scene score (no OpenCV dependency).

Used to nudge clip boundaries onto hard cuts so a clip doesn't open with a
few frames of the previous shot. PySceneDetect can replace this later if we need
adaptive/content-aware detection.
"""

from __future__ import annotations

import logging
import re
import subprocess

log = logging.getLogger(__name__)

_PTS_RE = re.compile(r"pts_time:([0-9.]+)")


def detect_scenes(input_ref: str, duration: float, threshold: float = 0.35) -> list[float]:
    # Downscale + sample at 4 fps: ~20x cheaper than full-res analysis and plenty for cut detection.
    vf = f"fps=4,scale=160:-2,select='gt(scene\\,{threshold})',showinfo"
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-i", input_ref, "-an", "-sn", "-dn", "-vf", vf, "-f", "null", "-"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=max(300, duration))
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        # Scene cuts only refine boundaries; never fail the job over them.
        log.warning("scene detection skipped: %s", exc)
        return []
    if res.returncode != 0:
        log.warning("scene detection failed: %s", res.stderr[-500:])
        return []
    cuts = sorted({round(float(m.group(1)), 3) for m in _PTS_RE.finditer(res.stderr)})
    return [c for c in cuts if 0 < c < duration]
