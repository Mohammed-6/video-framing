from __future__ import annotations

import re

from app.pipeline.face_track import (
    Face,
    Keyframe,
    Sample,
    build_crop_x_expr,
    keyframes_to_json,
    needs_tracking,
    plan_path,
    select_targets,
    simplify,
)

CROP_W = 0.316  # 9:16 window inside 16:9


def two_person_samples(speaker_by_second: list[str], fps: float = 4.0) -> list[Sample]:
    """Left person at 0.25, right person at 0.75; the speaker's mouth moves."""
    samples = []
    for i, who in enumerate(s for s in speaker_by_second for _ in range(int(fps))):
        faces = [Face(0.25, 0.4, 0.10, 0.18), Face(0.75, 0.4, 0.10, 0.18)]
        motion = [0.12, 0.01] if who == "L" else [0.01, 0.12]
        samples.append(Sample(t=i / fps, faces=faces, motion=motion))
    return samples


def eval_expr(expr: str, t: float) -> float:
    """Tiny evaluator for the subset of ffmpeg expressions we generate."""
    py = expr.replace("lt(", "_lt(").replace("gte(", "_gte(")
    return eval(py, {"_lt": lambda a, b: float(a < b), "_gte": lambda a, b: float(a >= b), "t": t})


def cx_at(keys: list[Keyframe], t: float) -> float:
    pts = keyframes_to_json(keys)
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, x0), (t1, x1) in zip(pts, pts[1:]):
        if t0 <= t < t1:
            return x0 + (x1 - x0) * (t - t0) / (t1 - t0)
    return pts[-1][1]


def test_follows_active_speaker_with_hard_cut():
    samples = two_person_samples(["L"] * 4 + ["R"] * 4)
    keys = plan_path(select_targets(samples), 8.0, 0.5, CROP_W)
    assert abs(cx_at(keys, 1.0) - 0.25) < 0.03
    assert abs(cx_at(keys, 7.5) - 0.75) < 0.03
    jumps = [k for k in keys if k.jump]
    assert len(jumps) == 1 and 4.0 <= jumps[0].t <= 5.25  # switch after the hysteresis hold


def test_hysteresis_ignores_brief_interjections():
    # Right person speaks for only half a second inside the left person's turn.
    samples = two_person_samples(["L"] * 3)
    for s in samples[5:7]:
        s.motion = [0.01, 0.12]
    keys = plan_path(select_targets(samples), 3.0, 0.5, CROP_W)
    assert not any(k.jump for k in keys)
    assert all(abs(k.cx - 0.25) < 0.03 for k in keys)


def test_single_moving_subject_is_eased_not_jittered():
    samples = [Sample(t=i / 4, faces=[Face(0.3 + 0.01 * i, 0.4, 0.1, 0.18)], motion=[0.05]) for i in range(40)]
    keys = plan_path(select_targets(samples), 10.0, 0.5, CROP_W)
    assert not any(k.jump for k in keys)
    xs = [k.cx for k in keys]
    assert xs == sorted(xs)  # smooth pan in one direction
    assert len(keys) < 15  # simplified, not one keyframe per sample


def test_small_jitter_inside_dead_zone_keeps_camera_still():
    samples = [Sample(t=i / 4, faces=[Face(0.5 + (0.01 if i % 2 else -0.01), 0.4, 0.1, 0.18)], motion=[0.05]) for i in range(20)]
    keys = plan_path(select_targets(samples), 5.0, 0.5, CROP_W)
    assert len({round(k.cx, 3) for k in keys}) == 1


def test_scene_cut_resets_and_jumps():
    samples = [Sample(t=i / 4, faces=[Face(0.3, 0.4, 0.1, 0.18)], motion=[0.05]) for i in range(8)]
    samples += [Sample(t=(8 + i) / 4, faces=[Face(0.8, 0.4, 0.1, 0.18)], motion=[0.05], cut=(i == 0)) for i in range(8)]
    keys = plan_path(select_targets(samples), 4.0, 0.5, CROP_W)
    jump = [k for k in keys if k.jump]
    assert len(jump) == 1 and jump[0].t == 2.0
    assert abs(keys[-1].cx - min(0.8, 1 - CROP_W / 2)) < 0.01


def test_no_faces_falls_back_and_clamps_to_frame():
    samples = [Sample(t=i / 4, faces=[], motion=[]) for i in range(8)]
    keys = plan_path(select_targets(samples), 2.0, 0.0, CROP_W)
    assert [k.cx for k in keys] == [CROP_W / 2, CROP_W / 2]


def test_holds_position_when_face_briefly_lost():
    samples = [Sample(t=i / 4, faces=[Face(0.3, 0.4, 0.1, 0.18)], motion=[0.05]) for i in range(4)]
    samples += [Sample(t=(4 + i) / 4, faces=[], motion=[]) for i in range(4)]
    keys = plan_path(select_targets(samples), 2.0, 0.5, CROP_W)
    assert all(abs(k.cx - 0.3) < 0.01 for k in keys)


def test_crop_expression_matches_path_and_stays_in_bounds():
    keys = [Keyframe(0, 0.25), Keyframe(2, 0.25), Keyframe(2.5, 0.75, jump=True), Keyframe(4, 0.6), Keyframe(6, 0.6)]
    src_w, crop_px = 1920, 606
    expr = build_crop_x_expr(keys, src_w, crop_px)
    assert re.fullmatch(r"[0-9a-z().,+\-*/]+", expr), "must be safe inside a quoted filter option"

    def px(cx):
        return min(src_w - crop_px, max(0, cx * src_w - crop_px / 2))

    assert abs(eval_expr(expr, 1.0) - px(0.25)) < 1
    assert abs(eval_expr(expr, 2.4) - px(0.25)) < 1  # holds until the cut
    assert abs(eval_expr(expr, 2.5) - px(0.75)) < 1  # hard cut
    assert abs(eval_expr(expr, 3.25) - (px(0.75) + px(0.6)) / 2) < 2  # linear ease
    assert abs(eval_expr(expr, 10.0) - px(0.6)) < 1  # after the last keyframe
    for t in [x / 10 for x in range(0, 70)]:
        assert 0 <= eval_expr(expr, t) <= src_w - crop_px


def test_track_json_is_serializable_with_numpy_inputs():
    import json

    import numpy as np

    keys = [Keyframe(np.float32(0.0), np.float32(0.25)), Keyframe(np.float32(2.0), np.float32(0.5), jump=True)]
    json.dumps(keyframes_to_json(keys))


def test_static_path_gives_constant_expression():
    assert build_crop_x_expr([Keyframe(0, 0.5), Keyframe(5, 0.5)], 1920, 606) == str(int(0.5 * 1920 - 303))


def test_simplify_keeps_jumps_and_drops_collinear_points():
    keys = [Keyframe(t, 0.3 + 0.01 * t) for t in range(10)] + [Keyframe(10, 0.8, jump=True), Keyframe(12, 0.8)]
    out = simplify(keys)
    assert [k.t for k in out] == [0, 9, 10, 12]
    assert out[2].jump


def test_needs_tracking_only_for_wider_sources():
    assert needs_tracking(1920, 1080, 1080, 1920)
    assert not needs_tracking(1080, 1920, 1080, 1920)
    assert not needs_tracking(720, 1280, 1080, 1920)
