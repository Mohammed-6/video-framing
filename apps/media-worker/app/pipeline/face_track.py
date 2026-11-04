"""Speaker-following reframe: detect faces, pick the active speaker, plan a smooth crop path.

Pipeline (per clip, at render time):
  1. sample frames at SAMPLE_FPS with ffmpeg (downscaled BGR frames over a pipe)
  2. detect faces (OpenCV YuNet; Haar cascade fallback) and detect hard cuts
  3. associate faces into tracks; measure mouth-region motion per track
  4. choose the active speaker per sample (mouth activity + face size, with hysteresis)
  5. turn targets into a camera path: dead-zone + easing inside a shot, hard cuts on
     speaker switches and scene cuts
  6. simplify to keyframes -> ffmpeg crop `x` expression (see build_crop_x_expr)

Everything after step 2 is pure Python on small data and is unit-tested.
"""

from __future__ import annotations

import logging
import math
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator, Sequence

log = logging.getLogger(__name__)

SAMPLE_FPS = 4.0
ANALYSIS_WIDTH = 640


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Face:
    """Normalised to the frame: cx, cy, w, h in [0, 1]."""

    cx: float
    cy: float
    w: float
    h: float
    score: float = 1.0


@dataclass
class Sample:
    t: float  # seconds from clip start
    faces: list[Face]
    motion: list[float]  # mouth-region motion per face (same order), 0..1
    cut: bool = False  # hard cut between the previous sample and this one


@dataclass
class Track:
    id: int
    cx: float
    w: float
    last_t: float
    activity: float = 0.0  # EMA of mouth motion
    hits: int = 1


@dataclass(frozen=True)
class Keyframe:
    t: float
    cx: float  # crop window centre, normalised to frame width
    jump: bool = False  # True = hard cut into this keyframe


# ---------------------------------------------------------------------------
# Tracking & speaker selection (pure)
# ---------------------------------------------------------------------------

MATCH_DISTANCE = 0.12  # max centre movement (frame widths) between samples to keep a track
TRACK_TTL = 1.0  # seconds a track survives without detections
ACTIVITY_ALPHA = 0.45
SWITCH_MARGIN = 1.35  # challenger must beat the current speaker by 35%...
SWITCH_HOLD = 3  # ...for this many consecutive samples (~0.75 s)


@dataclass
class _TrackerState:
    tracks: dict[int, Track] = field(default_factory=dict)
    next_id: int = 0


def _associate(state: _TrackerState, sample: Sample) -> list[tuple[Track, float]]:
    """Greedy nearest-centre matching. Returns (track, motion) for each face in the sample."""
    if sample.cut:
        state.tracks.clear()
    for tid in [tid for tid, tr in state.tracks.items() if sample.t - tr.last_t > TRACK_TTL]:
        del state.tracks[tid]

    pairs = sorted(
        ((abs(f.cx - tr.cx), i, tid) for i, f in enumerate(sample.faces) for tid, tr in state.tracks.items()),
        key=lambda x: x[0],
    )
    face_to_track: dict[int, int] = {}
    used: set[int] = set()
    for dist, i, tid in pairs:
        if dist > MATCH_DISTANCE or i in face_to_track or tid in used:
            continue
        face_to_track[i] = tid
        used.add(tid)

    out: list[tuple[Track, float]] = []
    for i, f in enumerate(sample.faces):
        motion = sample.motion[i] if i < len(sample.motion) else 0.0
        if i in face_to_track:
            tr = state.tracks[face_to_track[i]]
            tr.cx = 0.6 * f.cx + 0.4 * tr.cx  # light smoothing of detector jitter
            tr.w = 0.6 * f.w + 0.4 * tr.w
            tr.last_t = sample.t
            tr.hits += 1
            tr.activity = ACTIVITY_ALPHA * motion + (1 - ACTIVITY_ALPHA) * tr.activity
        else:
            tr = Track(id=state.next_id, cx=f.cx, w=f.w, last_t=sample.t, activity=motion)
            state.tracks[tr.id] = tr
            state.next_id += 1
        out.append((tr, motion))
    return out


def _speaker_score(track: Track, present: Sequence[Track]) -> float:
    max_act = max((t.activity for t in present), default=0.0) or 1e-6
    max_w = max((t.w for t in present), default=0.0) or 1e-6
    return 0.65 * (track.activity / max_act) + 0.35 * (track.w / max_w)


def select_targets(samples: Sequence[Sample]) -> list[tuple[float, float | None, bool]]:
    """Per sample: (t, target cx or None if nobody visible, switched/cut flag)."""
    state = _TrackerState()
    current: int | None = None
    challenger: int | None = None
    challenge_count = 0
    out: list[tuple[float, float | None, bool]] = []

    for s in samples:
        matched = _associate(state, s)
        present = [tr for tr, _ in matched]
        switched = s.cut
        if s.cut:
            current = None
        if not present:
            out.append((s.t, None, switched))
            continue

        best = max(present, key=lambda tr: _speaker_score(tr, present))
        cur = next((tr for tr in present if tr.id == current), None)
        if cur is None:
            # Current speaker gone (or first sample/new shot): take the best immediately.
            switched = switched or current is not None
            current, challenger, challenge_count = best.id, None, 0
            cur = best
        elif best.id != cur.id and _speaker_score(best, present) > SWITCH_MARGIN * _speaker_score(cur, present):
            challenge_count = challenge_count + 1 if challenger == best.id else 1
            challenger = best.id
            if challenge_count >= SWITCH_HOLD:
                current, cur, switched = best.id, best, True
                challenger, challenge_count = None, 0
        else:
            challenger, challenge_count = None, 0
        out.append((s.t, cur.cx, switched))
    return out


# ---------------------------------------------------------------------------
# Camera path (pure)
# ---------------------------------------------------------------------------

DEAD_ZONE = 0.035  # start moving only when the subject drifts this far (frame widths)
SETTLE = 0.008  # ...and keep following until this close (avoids stop-and-go on slow pans)
EASE = 0.35  # fraction of the remaining distance covered per sample when moving


def plan_path(
    targets: Sequence[tuple[float, float | None, bool]],
    duration: float,
    fallback_cx: float,
    crop_w: float,
) -> list[Keyframe]:
    """Camera centre keyframes. `crop_w` is the crop width as a fraction of frame width."""
    half = crop_w / 2

    def clamp(cx: float) -> float:
        return min(1 - half, max(half, cx))

    if not any(cx is not None for _, cx, _ in targets):
        return [Keyframe(0.0, clamp(fallback_cx)), Keyframe(duration, clamp(fallback_cx))]

    # Before the first detection, use the first known target (avoid a pan-in from centre).
    first = next(cx for _, cx, _ in targets if cx is not None)
    cam = clamp(first)
    moving = False
    keys: list[Keyframe] = [Keyframe(0.0, cam)]
    for t, cx, switched in targets:
        if cx is None:
            moving = False
            keys.append(Keyframe(t, cam))  # hold position while nobody is visible
            continue
        target = clamp(cx)
        if switched and abs(target - cam) > DEAD_ZONE:
            cam, moving = target, False
            keys.append(Keyframe(t, cam, jump=True))
            continue
        gap = abs(target - cam)
        if gap > DEAD_ZONE:
            moving = True
        elif gap < SETTLE:
            moving = False
        if moving:
            cam = cam + (target - cam) * EASE
        keys.append(Keyframe(t, clamp(cam)))
    keys.append(Keyframe(duration, keys[-1].cx))
    return simplify(_dedupe(keys))


def _dedupe(keys: list[Keyframe]) -> list[Keyframe]:
    out: list[Keyframe] = []
    for k in sorted(keys, key=lambda k: (k.t, not k.jump)):
        if out and abs(out[-1].t - k.t) < 1e-6:
            if k.jump:
                out[-1] = k
            continue
        out.append(k)
    return out


def _rdp(points: list[Keyframe], eps: float) -> list[Keyframe]:
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    span = b.t - a.t or 1e-9
    worst_i, worst_d = 0, -1.0
    for i in range(1, len(points) - 1):
        p = points[i]
        expected = a.cx + (b.cx - a.cx) * (p.t - a.t) / span
        d = abs(p.cx - expected)
        if d > worst_d:
            worst_i, worst_d = i, d
    if worst_d <= eps:
        return [a, b]
    return _rdp(points[: worst_i + 1], eps)[:-1] + _rdp(points[worst_i:], eps)


def simplify(keys: list[Keyframe], eps: float = 0.006) -> list[Keyframe]:
    """Ramer–Douglas–Peucker per continuous segment; jumps are always kept."""
    out: list[Keyframe] = []
    seg: list[Keyframe] = []
    for k in keys:
        if k.jump and seg:
            out.extend(_rdp(seg, eps))
            seg = []
        seg.append(k)
    out.extend(_rdp(seg, eps))
    return out


# ---------------------------------------------------------------------------
# Group framing: zoom out (up to a letterboxed full frame) to keep everyone in shot
# ---------------------------------------------------------------------------

ZOOM_STEPS = 4  # tight 9:16 ... full frame
RELEVANT_FACE_RATIO = 0.45  # faces smaller than this x the largest are background extras
FACE_MARGIN = 0.6  # extra space around each face, in face widths, on each side
MIN_LEVEL_RUN = 4  # samples (~1 s) a zoomed-out level must last before we cut to another
ZOOM_IN_MIN_RUN = 8  # zooming back in needs ~2 s of evidence (faces turn away, blur, occlusion)
STEADY_GROUP_HOLD = 8  # steady mode: keep framing the group ~2 s after it's last seen


@dataclass
class FramingPlan:
    """Window widths (fraction of source width), one shared centre path, and which width is live when."""

    levels: list[float]
    centers: list[Keyframe]
    segments: list[tuple[float, float, int]]  # (start, end, level index), covering [0, duration]

    @property
    def is_static(self) -> bool:
        return len(self.used_levels) == 1 and len({round(k.cx, 4) for k in self.centers}) <= 1

    @property
    def used_levels(self) -> list[int]:
        return sorted({lvl for _, _, lvl in self.segments})


def zoom_levels(tight_w: float) -> list[float]:
    tight_w = min(1.0, tight_w)
    return [tight_w + (1.0 - tight_w) * i / (ZOOM_STEPS - 1) for i in range(ZOOM_STEPS)]


def zoom_to_width(zoom: float, tight_w: float) -> float:
    """Manual zoom 0..1 -> window width fraction (0 = fill 9:16, 1 = whole frame)."""
    zoom = min(1.0, max(0.0, zoom))
    return tight_w + (1.0 - tight_w) * zoom


def relevant_faces(faces: Sequence[Face]) -> list[Face]:
    if not faces:
        return []
    biggest = max(f.w for f in faces)
    return [f for f in faces if f.w >= RELEVANT_FACE_RATIO * biggest]


def group_span(faces: Sequence[Face]) -> tuple[float, float]:
    """(required window width, centre) to fit all faces with margins."""
    left = min(f.cx - f.w * (0.5 + FACE_MARGIN) for f in faces)
    right = max(f.cx + f.w * (0.5 + FACE_MARGIN) for f in faces)
    left, right = max(0.0, left), min(1.0, right)
    return right - left, (left + right) / 2


def level_for(width: float, levels: Sequence[float]) -> int:
    for i, w in enumerate(levels):
        if width <= w + 1e-6:
            return i
    return len(levels) - 1


def _runs(values: Sequence[int]) -> list[list[int]]:
    """[[value, start, end_exclusive], ...]"""
    runs: list[list[int]] = []
    for i, v in enumerate(values):
        if runs and runs[-1][0] == v:
            runs[-1][2] = i + 1
        else:
            runs.append([v, i, i + 1])
    return runs


def smooth_levels(raw: Sequence[int], cuts: Sequence[bool]) -> list[int]:
    """Stabilise per-sample zoom levels within each shot.

    1. drop 1-sample zoom-out spikes (detector false positives)
    2. zoom out one sample early so people aren't cut off as they enter
    3. merge short runs into the wider neighbour (prefer showing everyone). Asymmetric: a
       tighter-than-neighbour run must last ZOOM_IN_MIN_RUN, a wider one MIN_LEVEL_RUN — zoom
       out fast so nobody is cut off, zoom in only when the group has really gone.
    """
    out: list[int] = []
    shot_starts = [i for i, c in enumerate(cuts) if c or i == 0]
    bounds = list(zip(shot_starts, shot_starts[1:] + [len(raw)]))
    for a, b in bounds:
        lv = list(raw[a:b])
        n = len(lv)
        for i in range(n):  # 1
            prev_v = lv[i - 1] if i > 0 else None
            next_v = lv[i + 1] if i + 1 < n else None
            neighbours = [v for v in (prev_v, next_v) if v is not None]
            if neighbours and lv[i] > max(neighbours):
                lv[i] = max(neighbours)
        lv = [max(lv[max(0, i - 1) : i + 2]) if n else 0 for i in range(n)]  # 2
        changed = True
        while changed:  # 3
            changed = False
            runs = _runs(lv)
            if len(runs) < 2:
                break
            for ri, (v, s, e) in enumerate(runs):
                neigh = [runs[j][0] for j in (ri - 1, ri + 1) if 0 <= j < len(runs)]
                target = max(neigh)
                # Only a run entered *from* a wider framing is a zoom-in; the tight stretch at the
                # start of a shot (before someone walks in) just needs the normal minimum.
                zooming_in = ri > 0 and runs[ri - 1][0] > v
                needed = ZOOM_IN_MIN_RUN if zooming_in else MIN_LEVEL_RUN
                if e - s >= needed:
                    continue
                if target != v:
                    lv[s:e] = [target] * (e - s)
                    changed = True
                    break
        out.extend(lv)
    return out


def steady_levels(lv: Sequence[int]) -> list[int]:
    """One layout for the whole clip: if any part needs to zoom out, use the widest needed
    level everywhere, so the clip never jumps between a tight crop and a zoomed-out, blurred frame."""
    widest = max(lv, default=0)
    return [widest] * len(lv)


def plan_framing(
    samples: Sequence[Sample],
    duration: float,
    fallback_cx: float,
    tight_w: float,
    multi_face: str = "group",
    steady: bool = False,
) -> FramingPlan:
    levels = zoom_levels(tight_w)
    speaker = select_targets(samples)
    if not samples:
        return FramingPlan(levels, plan_path([], duration, fallback_cx, tight_w), [(0.0, duration, 0)])

    raw: list[int] = []
    group_centre: list[float | None] = []
    for s in samples:
        rel = relevant_faces(s.faces)
        if multi_face == "group" and len(rel) >= 2:
            width, centre = group_span(rel)
            raw.append(level_for(width, levels))
            group_centre.append(centre)
        else:
            raw.append(0)
            group_centre.append(None)
    lv = smooth_levels(raw, [s.cut for s in samples])

    if steady and multi_face == "group" and max(lv, default=0) > 0:
        lv = steady_levels(lv)
        # Inside the fixed wide window: frame the group while it's there (and briefly after,
        # so a face turning away doesn't cause a pan), otherwise ease over to the speaker.
        known = [i for i, c in enumerate(group_centre) if c is not None]
        for i in range(len(group_centre)):
            if group_centre[i] is None and known:
                k = min(known, key=lambda j: abs(j - i))
                if abs(k - i) <= STEADY_GROUP_HOLD and not any(s.cut for s in samples[min(i, k) + 1 : max(i, k) + 1]):
                    group_centre[i] = group_centre[k]
        targets = [(t, group_centre[i] if group_centre[i] is not None else spk_cx, switched)
                   for i, (t, spk_cx, switched) in enumerate(speaker)]
        centers = plan_path(targets, duration, fallback_cx, tight_w)
        return FramingPlan(levels, centers, [(0.0, duration, lv[0])])

    # Samples zoomed out by smoothing (early zoom-out, merged runs) have no group centre of
    # their own: borrow the nearest one from the same run so the zoom cut lands on the group
    # instead of panning to it afterwards.
    for v, s, e in _runs(lv):
        if v == 0:
            continue
        known = [i for i in range(s, e) if group_centre[i] is not None]
        if not known:
            continue
        for i in range(s, e):
            if group_centre[i] is None:
                group_centre[i] = group_centre[min(known, key=lambda k: abs(k - i))]

    targets: list[tuple[float, float | None, bool]] = []
    for i, (t, spk_cx, switched) in enumerate(speaker):
        cx = group_centre[i] if group_centre[i] is not None else spk_cx
        level_change = i > 0 and lv[i] != lv[i - 1]
        targets.append((t, cx, switched or level_change))
    centers = plan_path(targets, duration, fallback_cx, tight_w)

    segments: list[tuple[float, float, int]] = []
    for v, s, e in _runs(lv):
        start = 0.0 if s == 0 else samples[s].t
        end = duration if e == len(samples) else samples[e].t
        segments.append((start, end, v))
    return FramingPlan(levels, centers, segments)


def fixed_plan(duration: float, center_x: float, width: float) -> FramingPlan:
    return FramingPlan([width], [Keyframe(0.0, center_x), Keyframe(duration, center_x)], [(0.0, duration, 0)])


def plan_to_json(plan: FramingPlan) -> list[list[float]]:
    """Preview track [[t, cx, window_width], ...]; extra points at zoom cuts."""
    def width_at(t: float) -> float:
        for s, e, lvl in plan.segments:
            if s <= t < e:
                return plan.levels[lvl]
        return plan.levels[plan.segments[-1][2]]

    times = sorted({k.t for k in plan.centers} | {s for s, _, _ in plan.segments[1:]})
    pts = keyframes_to_json(plan.centers)
    by_t: list[list[float]] = []
    for t in times:
        cx = next((p[1] for p in reversed(pts) if p[0] <= t + 1e-9), pts[0][1])
        by_t.append([round(float(t), 3), cx, round(width_at(t), 4)])
    # Hold the previous width until just before each zoom cut, so interpolation doesn't "zoom".
    out: list[list[float]] = []
    for p in by_t:
        if out and abs(out[-1][2] - p[2]) > 1e-6:
            out.append([round(max(out[-1][0], p[0] - JUMP_EPSILON), 3), out[-1][1], out[-1][2]])
        out.append(p)
    return out


# ---------------------------------------------------------------------------
# ffmpeg expression
# ---------------------------------------------------------------------------

JUMP_EPSILON = 0.001


def build_crop_x_expr(keys: Sequence[Keyframe], src_w: int, crop_w_px: int) -> str:
    """Piecewise-linear crop `x` (pixels) as a flat sum of gated segments — no nesting.

    A jump keyframe holds the previous value until (t - ε), then switches.
    Evaluated per frame by the crop filter, with `t` = seconds since clip start.
    """
    max_x = max(0, src_w - crop_w_px)

    def px(cx: float) -> float:
        return round(min(max_x, max(0.0, cx * src_w - crop_w_px / 2)), 1)

    pts: list[tuple[float, float]] = []
    for k in keys:
        if k.jump and pts:
            pts.append((max(pts[-1][0], k.t - JUMP_EPSILON), pts[-1][1]))
        pts.append((k.t, px(k.cx)))
    pts = [p for i, p in enumerate(pts) if i == 0 or p[0] > pts[i - 1][0] or p[1] != pts[i - 1][1]]

    if len(pts) == 1 or all(abs(p[1] - pts[0][1]) < 0.5 for p in pts):
        return str(int(pts[0][1]))

    terms = [f"lt(t,{pts[0][0]:.3f})*{pts[0][1]}"]
    for (t0, x0), (t1, x1) in zip(pts, pts[1:]):
        if t1 <= t0:
            continue
        slope = (x1 - x0) / (t1 - t0)
        seg = f"{x0}" if abs(slope) < 1e-9 else f"({x0}+{slope:.4f}*(t-{t0:.3f}))"
        terms.append(f"gte(t,{t0:.3f})*lt(t,{t1:.3f})*{seg}")
    terms.append(f"gte(t,{pts[-1][0]:.3f})*{pts[-1][1]}")
    return "+".join(terms)


def keyframes_to_json(keys: Sequence[Keyframe]) -> list[list[float]]:
    """Compact [[t, cx], ...] for storage/preview; jumps become a duplicated time."""
    out: list[list[float]] = []
    for k in keys:
        if k.jump and out:
            out.append([round(max(out[-1][0], float(k.t) - JUMP_EPSILON), 3), out[-1][1]])
        out.append([round(float(k.t), 3), round(float(k.cx), 4)])
    return out


# ---------------------------------------------------------------------------
# Vision (OpenCV) — not exercised by unit tests
# ---------------------------------------------------------------------------


class FaceDetector:
    def __init__(self, model_path: str | None, min_score: float = 0.7):
        import cv2

        self.cv2 = cv2
        self.yunet = None
        if model_path and Path(model_path).exists():
            self.yunet = cv2.FaceDetectorYN.create(model_path, "", (320, 320), min_score, 0.3, 5000)
        else:
            log.warning("YuNet model not found at %s; using Haar cascade (less accurate)", model_path)
            self.haar = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    def detect(self, frame) -> list[Face]:
        h, w = frame.shape[:2]
        if self.yunet is not None:
            self.yunet.setInputSize((w, h))
            _, faces = self.yunet.detect(frame)
            rows = [] if faces is None else faces
            boxes = [(r[0], r[1], r[2], r[3], float(r[14])) for r in rows]
        else:
            gray = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2GRAY)
            found = self.haar.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(int(w * 0.04), int(w * 0.04)))
            boxes = [(x, y, bw, bh, 1.0) for (x, y, bw, bh) in found]
        out = []
        for x, y, bw, bh, score in boxes:
            # numpy scalars -> plain floats (they end up in JSON).
            x, y, bw, bh, score = float(x), float(y), float(bw), float(bh), float(score)
            if bw < w * 0.025:  # ignore tiny background faces
                continue
            out.append(Face(cx=(x + bw / 2) / w, cy=(y + bh / 2) / h, w=bw / w, h=bh / h, score=score))
        return out


def _mouth_patch(cv2, gray, face: Face):
    h, w = gray.shape[:2]
    x0 = int((face.cx - face.w * 0.3) * w)
    x1 = int((face.cx + face.w * 0.3) * w)
    y0 = int((face.cy + face.h * 0.1) * h)
    y1 = int((face.cy + face.h * 0.5) * h)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return cv2.resize(gray[y0:y1, x0:x1], (32, 16), interpolation=cv2.INTER_AREA)


def iter_frames(input_ref: str, start: float, end: float, src_w: int, src_h: int) -> Iterator[tuple[float, object]]:
    """Downscaled BGR frames at SAMPLE_FPS between [start, end), via an ffmpeg pipe."""
    import numpy as np

    w = min(ANALYSIS_WIDTH, src_w - src_w % 2)
    h = max(2, int(round(src_h * w / src_w / 2)) * 2)
    cmd = [
        "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-i", input_ref, "-t", f"{end - start:.3f}",
        "-an", "-sn", "-vf", f"fps={SAMPLE_FPS},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = w * h * 3
    i = 0
    try:
        assert proc.stdout is not None
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield i / SAMPLE_FPS, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            i += 1
    finally:
        proc.kill()
        proc.wait()


def analyze_clip(
    input_ref: str,
    start: float,
    end: float,
    src_w: int,
    src_h: int,
    model_path: str | None,
    on_progress: Callable[[float], None] | None = None,
) -> list[Sample]:
    import cv2
    import numpy as np

    detector = FaceDetector(model_path)
    samples: list[Sample] = []
    prev_gray = None
    prev_hist = None
    prev_patches: dict[int, object] = {}
    total = max(1, int((end - start) * SAMPLE_FPS))
    for idx, (t, frame) in enumerate(iter_frames(input_ref, start, end, src_w, src_h)):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)], [0, 1], None, [32, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        cut = prev_hist is not None and cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL) < 0.55
        faces = detector.detect(frame)

        # Mouth motion: compare each face's mouth patch with the nearest face's patch in the previous frame.
        motion: list[float] = []
        patches: dict[int, object] = {}
        for fi, f in enumerate(faces):
            patch = _mouth_patch(cv2, gray, f)
            patches[fi] = (f, patch)
            score = 0.0
            if patch is not None and prev_gray is not None and not cut:
                near = min(prev_patches.values(), key=lambda fp: abs(fp[0].cx - f.cx), default=None)
                if near is not None and near[1] is not None and abs(near[0].cx - f.cx) < MATCH_DISTANCE:
                    score = float(np.mean(cv2.absdiff(patch, near[1]))) / 255.0
            motion.append(score)
        samples.append(Sample(t=t, faces=faces, motion=motion, cut=cut))
        prev_gray, prev_hist, prev_patches = gray, hist, patches
        if on_progress and idx % 8 == 0:
            on_progress(min(1.0, idx / total))
    return samples


def tight_width(src_w: int, src_h: int, out_w: int, out_h: int) -> float:
    """Width of a full-height out_w:out_h window, as a fraction of the source width."""
    return min(1.0, (src_h * out_w / out_h) / src_w)


def track_and_plan(
    input_ref: str,
    start: float,
    end: float,
    src_w: int,
    src_h: int,
    out_w: int,
    out_h: int,
    fallback_cx: float,
    model_path: str | None,
    multi_face: str = "group",
    on_progress: Callable[[float], None] | None = None,
    steady: bool = False,
) -> tuple[FramingPlan, int]:
    """Returns (plan, samples with faces). With no faces the plan is a fixed tight crop."""
    samples = analyze_clip(input_ref, start, end, src_w, src_h, model_path, on_progress)
    plan = plan_framing(samples, end - start, fallback_cx, tight_width(src_w, src_h, out_w, out_h), multi_face, steady)
    faces_seen = sum(1 for s in samples if s.faces)
    log.info(
        "framing: %d/%d samples with faces, %d centre keys, zoom levels used %s",
        faces_seen, len(samples), len(plan.centers), plan.used_levels,
    )
    return plan, faces_seen


def needs_tracking(src_w: int, src_h: int, out_w: int, out_h: int) -> bool:
    """Only sources wider than the target aspect can pan horizontally."""
    return src_w / src_h > out_w / out_h + 1e-3 and not math.isclose(src_w / src_h, out_w / out_h, rel_tol=0.01)
