"""Reframing a landscape source into a vertical (9:16) frame.

Two paths:
  * static crop (`crop_filter`) — a fixed window, used for fixed framing at zoom 0 and for
    sources that are already vertical.
  * framing plan (`build_framing_graph`) — the window follows a centre path and can zoom out
    in steps up to the full frame, letterboxed with black bars. Each zoom level used becomes
    one branch (crop -> scale -> pad to the output size); timed overlays cut between them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .face_track import FramingPlan


@dataclass(frozen=True)
class CropBox:
    x: int
    y: int
    w: int
    h: int


def _even(n: float) -> int:
    """libx264 with yuv420p needs even dimensions."""
    return max(2, int(n) // 2 * 2)


def compute_crop(src_w: int, src_h: int, center_x: float = 0.5, aspect_w: int = 9, aspect_h: int = 16) -> CropBox:
    """Largest window with the target aspect that fits the source, centred at `center_x` (0..1)."""
    if src_w <= 0 or src_h <= 0:
        raise ValueError("source dimensions must be positive")
    target = aspect_w / aspect_h
    center_x = min(1.0, max(0.0, center_x))
    if src_w / src_h >= target:
        # Source is wider than the target: full height, crop the sides.
        h = _even(src_h)
        w = min(_even(src_h * target), _even(src_w))
        x = round(center_x * src_w - w / 2)
        x = min(max(0, x), src_w - w)
        return CropBox(x=x - x % 2, y=0, w=w, h=h)
    # Source is narrower/taller than the target: full width, crop top and bottom around the centre.
    w = _even(src_w)
    h = min(_even(src_w / target), _even(src_h))
    y = (src_h - h) // 2
    return CropBox(x=0, y=y - y % 2, w=w, h=h)


def crop_filter(src_w: int, src_h: int, center_x: float, out_w: int, out_h: int) -> str:
    box = compute_crop(src_w, src_h, center_x, out_w, out_h)
    return f"crop=w={box.w}:h={box.h}:x={box.x}:y={box.y},scale={out_w}:{out_h}:flags=lanczos,setsar=1"


def _gate(segments: list[tuple[float, float]]) -> str:
    return "+".join(f"gte(t,{a:.3f})*lt(t,{b:.3f})" for a, b in segments)


LETTERBOX_FILLS = ("blur", "black")


def blur_background(in_label: str, out_label: str, out_w: int, out_h: int) -> str:
    """Scale-to-cover, heavy blur at 1/8 resolution (cheap), back to full size, slightly darkened."""
    sw, sh = _even(out_w / 8), _even(out_h / 8)
    radius = max(2, min(sw, sh) // 6)
    return (
        f"[{in_label}]scale={sw}:{sh}:force_original_aspect_ratio=increase,crop={sw}:{sh},"
        f"boxblur=luma_radius={radius}:luma_power=2,scale={out_w}:{out_h}:flags=bilinear,"
        f"eq=brightness=-0.07:saturation=0.85[{out_label}]"
    )


def _branch(
    in_label: str, out_label: str, win_w: int, h: int, x_opt: str, out_w: int, out_h: int, fill: str, tag: str
) -> str:
    """crop the window -> fit to out_w (letterboxed if wider than 9:16) -> out_w x out_h."""
    scaled_h = min(out_h, _even(round(out_w * h / win_w)))
    crop = f"crop=w={win_w}:h={h}:x={x_opt}:y=0"
    if scaled_h >= out_h:
        return f"[{in_label}]{crop},scale={out_w}:{out_h}:flags=lanczos,setsar=1[{out_label}]"
    y = (out_h - scaled_h) // 2 // 2 * 2
    if fill == "black":
        return (
            f"[{in_label}]{crop},scale={out_w}:{scaled_h}:flags=lanczos,"
            f"pad={out_w}:{out_h}:0:{y}:black,setsar=1[{out_label}]"
        )
    # Blurred copy of the same (moving) window fills the bars.
    return ";".join(
        [
            f"[{in_label}]{crop},split[fg{tag}][bg{tag}]",
            blur_background(f"bg{tag}", f"bb{tag}", out_w, out_h),
            f"[fg{tag}]scale={out_w}:{scaled_h}:flags=lanczos[fs{tag}]",
            f"[bb{tag}][fs{tag}]overlay=0:{y},setsar=1[{out_label}]",
        ]
    )


def build_framing_graph(
    plan: "FramingPlan",
    src_w: int,
    src_h: int,
    out_w: int,
    out_h: int,
    in_label: str = "0:v",
    fill: str = "blur",
) -> tuple[str, str]:
    """filter_complex fragment producing an out_w x out_h stream. Returns (graph, output label).

    `fill`: what goes above/below a zoomed-out frame — "blur" (blurred copy) or "black".
    """
    from .face_track import build_crop_x_expr

    fill = fill if fill in LETTERBOX_FILLS else "blur"
    used = plan.used_levels
    h = _even(src_h)
    windows: dict[int, tuple[int, str]] = {}
    for lvl in used:
        win_w = min(_even(src_w), max(2, _even(plan.levels[lvl] * src_w)))
        x = build_crop_x_expr(plan.centers, src_w, win_w)
        windows[lvl] = (win_w, x if x.lstrip("-").isdigit() else f"'{x}'")

    if len(used) == 1:
        win_w, x_opt = windows[used[0]]
        return _branch(in_label, "framed", win_w, h, x_opt, out_w, out_h, fill, "0"), "framed"

    # Base = the level on screen longest; others overlay only while they're live.
    duration = {lvl: sum(e - s for s, e, l in plan.segments if l == lvl) for lvl in used}
    base = max(used, key=lambda lvl: duration[lvl])
    order = [base] + [lvl for lvl in used if lvl != base]
    parts = [f"[{in_label}]split={len(order)}" + "".join(f"[s{lvl}]" for lvl in order)]
    for lvl in order:
        win_w, x_opt = windows[lvl]
        parts.append(_branch(f"s{lvl}", f"z{lvl}", win_w, h, x_opt, out_w, out_h, fill, str(lvl)))
    current = f"z{base}"
    for i, lvl in enumerate(order[1:], 1):
        gate = _gate([(s, e) for s, e, l in plan.segments if l == lvl])
        nxt = "framed" if i == len(order) - 1 else f"o{i}"
        parts.append(f"[{current}][z{lvl}]overlay=0:0:enable='{gate}'[{nxt}]")
        current = nxt
    return ";".join(parts), "framed"
