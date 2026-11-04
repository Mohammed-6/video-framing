from __future__ import annotations

import json
import re

from app.pipeline.face_track import (
    MIN_LEVEL_RUN,
    Face,
    Sample,
    fixed_plan,
    group_span,
    plan_framing,
    plan_to_json,
    relevant_faces,
    smooth_levels,
    zoom_levels,
    zoom_to_width,
)

TIGHT = (1080 * 9 / 16) / 1920  # 0.316: 9:16 window in a 1920x1080 source


def face(cx, w=0.08):
    return Face(cx, 0.4, w, w * 1.6)


def samples_for(spec: list[list[Face]], fps=4.0, cuts=()) -> list[Sample]:
    return [Sample(t=i / fps, faces=f, motion=[0.05] * len(f), cut=i in cuts) for i, f in enumerate(spec)]


def level_at(plan, t):
    return next(lvl for s, e, lvl in plan.segments if s <= t < e)


# -- face selection -------------------------------------------------------------

def test_background_faces_are_ignored():
    faces = [face(0.3, 0.12), face(0.7, 0.11), face(0.5, 0.03)]  # tiny face = extra in the crowd
    assert [f.cx for f in relevant_faces(faces)] == [0.3, 0.7]


def test_group_span_includes_margins():
    width, centre = group_span([face(0.3, 0.1), face(0.6, 0.1)])
    assert abs(centre - 0.45) < 1e-9
    assert abs(width - (0.6 + 0.11 - (0.3 - 0.11))) < 1e-9


# -- zoom levels ------------------------------------------------------------------

def test_two_people_far_apart_zoom_out_to_full_frame():
    plan = plan_framing(samples_for([[face(0.15), face(0.85)]] * 16), 4.0, 0.5, TIGHT)
    assert plan.used_levels == [len(plan.levels) - 1]  # letterboxed full frame
    assert plan.levels[-1] == 1.0
    assert abs(plan.centers[0].cx - 0.5) < 0.02


def test_two_people_close_together_stay_tight_and_centred_between_them():
    plan = plan_framing(samples_for([[face(0.45, 0.06), face(0.55, 0.06)]] * 16), 4.0, 0.5, TIGHT)
    assert plan.used_levels == [0]
    assert abs(plan.centers[0].cx - 0.5) < 0.02


def test_intermediate_zoom_for_medium_spread():
    plan = plan_framing(samples_for([[face(0.35), face(0.65)]] * 16), 4.0, 0.5, TIGHT)
    (lvl,) = plan.used_levels
    assert 0 < lvl < len(plan.levels) - 1  # zoomed out just enough, not all the way


def test_follow_speaker_mode_never_zooms():
    plan = plan_framing(samples_for([[face(0.15), face(0.85)]] * 16), 4.0, 0.5, TIGHT, multi_face="speaker")
    assert plan.used_levels == [0]


def test_person_entering_triggers_zoom_out_slightly_early_and_zoom_in_waits():
    spec = [[face(0.3)]] * 12 + [[face(0.3), face(0.8)]] * 12 + [[face(0.3)]] * 12
    plan = plan_framing(samples_for(spec), 9.0, 0.5, TIGHT)
    assert level_at(plan, 1.0) == 0
    assert level_at(plan, 2.75) > 0  # one sample before the second person appears at t=3.0
    assert level_at(plan, 5.0) > 0
    assert level_at(plan, 8.5) == 0


def test_single_frame_false_positive_does_not_zoom():
    spec = [[face(0.3)]] * 10 + [[face(0.3), face(0.9)]] + [[face(0.3)]] * 10
    plan = plan_framing(samples_for(spec), 5.25, 0.5, TIGHT)
    assert plan.used_levels == [0]


def test_faces_lost_briefly_inside_group_shot_keep_the_wide_frame():
    # Both people turn away for ~1 s (only one face detected), then are back: no zoom-in blip.
    spec = [[face(0.15), face(0.85)]] * 12 + [[face(0.15)]] * 4 + [[face(0.15), face(0.85)]] * 12
    plan = plan_framing(samples_for(spec), 7.0, 0.5, TIGHT)
    assert len(plan.segments) == 1 and plan.used_levels == [len(plan.levels) - 1]


def test_zoom_in_happens_once_the_group_has_really_gone():
    spec = [[face(0.15), face(0.85)]] * 12 + [[face(0.15)]] * 12
    plan = plan_framing(samples_for(spec), 6.0, 0.5, TIGHT)
    assert [lvl for _, _, lvl in plan.segments] == [len(plan.levels) - 1, 0]


def test_smooth_levels_merges_short_runs_into_wider_and_respects_cuts():
    # Someone appears briefly: zoom out a sample early, then stay wide >= 2 s before zooming in.
    raw = [0] * 8 + [2] * 2 + [0] * 12
    assert smooth_levels(raw, [False] * 22) == [0] * 7 + [2] * 4 + [0] * 11
    raw = [0] * 8 + [2] * 2 + [0] * 7  # too little time left in the shot to zoom back in
    assert smooth_levels(raw, [False] * 17) == [0] * 7 + [2] * 10
    flicker = [0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0]
    out = smooth_levels(flicker, [False] * 12)
    runs = [len(list(g)) for _, g in __import__("itertools").groupby(out)]
    assert all(r >= MIN_LEVEL_RUN for r in runs)
    # A cut starts a fresh shot: the short first shot keeps its own level.
    cuts = [False, False, True] + [False] * 5
    assert smooth_levels([2, 2, 0, 0, 0, 0, 0, 0], cuts)[:2] == [2, 2]


def test_zoom_cut_is_a_hard_cut_in_the_centre_path():
    spec = [[face(0.2)]] * 12 + [[face(0.2), face(0.8)]] * 12
    plan = plan_framing(samples_for(spec), 6.0, 0.5, TIGHT)
    change_t = plan.segments[1][0]
    assert any(k.jump and abs(k.t - change_t) < 1e-6 for k in plan.centers)


def test_preview_json_carries_width_and_holds_until_cut():
    spec = [[face(0.2)]] * 12 + [[face(0.2), face(0.8)]] * 12
    plan = plan_framing(samples_for(spec), 6.0, 0.5, TIGHT)
    track = plan_to_json(plan)
    json.dumps(track)
    assert all(len(p) == 3 for p in track)
    widths = sorted({p[2] for p in track})
    assert widths[0] == round(TIGHT, 4) and widths[-1] > TIGHT
    change = plan.segments[1][0]
    before = [p for p in track if p[0] < change]
    assert before[-1][2] == round(TIGHT, 4) and change - before[-1][0] < 0.01


def test_manual_zoom_mapping():
    assert zoom_to_width(0, TIGHT) == TIGHT
    assert zoom_to_width(1, TIGHT) == 1.0
    assert zoom_levels(TIGHT)[0] == TIGHT and zoom_levels(TIGHT)[-1] == 1.0


# -- steady layout (one framing for the whole clip) ---------------------------------

def test_steady_mode_keeps_the_wide_layout_for_the_whole_clip():
    # alone for 3 s, joined by a second person for 3 s, alone again for 3 s
    spec = [[face(0.3)]] * 12 + [[face(0.15), face(0.85)]] * 12 + [[face(0.3)]] * 12
    switching = plan_framing(samples_for(spec), 9.0, 0.5, TIGHT)
    steady = plan_framing(samples_for(spec), 9.0, 0.5, TIGHT, steady=True)
    assert len(switching.used_levels) > 1  # the old behaviour cuts tight -> wide -> tight
    assert steady.segments == [(0.0, 9.0, len(steady.levels) - 1)]  # one layout, start to end


def test_steady_mode_follows_the_speaker_inside_the_wide_frame():
    spec = [[face(0.15), face(0.85)]] * 8 + [[face(0.7)]] * 24
    plan = plan_framing(samples_for(spec), 8.0, 0.5, TIGHT, steady=True)
    assert len(plan.used_levels) == 1
    # group centre first, then it settles toward the remaining person (clamped to the window)
    assert abs(plan.centers[0].cx - 0.5) < 0.02
    assert plan.centers[-1].cx > 0.55


def test_steady_mode_changes_nothing_for_single_person_clips():
    spec = [[face(0.4)]] * 16
    assert plan_framing(samples_for(spec), 4.0, 0.5, TIGHT, steady=True).used_levels == [0]


def test_steady_mode_is_ignored_when_following_the_speaker():
    spec = [[face(0.3)]] * 12 + [[face(0.15), face(0.85)]] * 12
    plan = plan_framing(samples_for(spec), 6.0, 0.5, TIGHT, multi_face="speaker", steady=True)
    assert plan.used_levels == [0]
