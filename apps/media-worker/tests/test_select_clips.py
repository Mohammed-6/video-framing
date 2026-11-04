from __future__ import annotations

import json

from app.config import Settings
from app.models import ClipPlanItem
from app.pipeline.select_clips import (
    MAX_OVERLAP_SECONDS,
    SelectionParams,
    parse_llm_items,
    plan_heuristic,
    select_clips,
    validate_plan,
)

PARAMS = SelectionParams(target_clip_count=5, min_duration=20, max_duration=60)
DURATION = 600.0


def item(start, end, score=0.5, title="t"):
    return ClipPlanItem(startSeconds=start, endSeconds=end, title=title, hook="", reason="", score=score)


def _assert_valid(clips, duration=DURATION, params=PARAMS):
    for c in clips:
        assert 0 <= c.startSeconds < c.endSeconds <= duration
        assert params.min_duration - 0.5 <= c.endSeconds - c.startSeconds <= params.max_duration + 0.5
        assert 0 <= c.score <= 1
    for i, a in enumerate(clips):
        for b in clips[i + 1 :]:
            overlap = min(a.endSeconds, b.endSeconds) - max(a.startSeconds, b.startSeconds)
            assert overlap <= MAX_OVERLAP_SECONDS


def test_clamps_to_source_duration(podcast_segments):
    clips = validate_plan([item(570, 700)], podcast_segments, DURATION, PARAMS)
    _assert_valid(clips)
    assert clips and clips[0].endSeconds <= DURATION


def test_drops_clip_too_short_at_end_of_video(podcast_segments):
    assert validate_plan([item(590, 599)], podcast_segments, DURATION, PARAMS) == []


def test_trims_overlong_clip_to_max(podcast_segments):
    clips = validate_plan([item(16, 200)], podcast_segments, DURATION, PARAMS)
    assert len(clips) == 1
    assert clips[0].endSeconds - clips[0].startSeconds <= PARAMS.max_duration + 0.5


def test_extends_short_clip_to_min(podcast_segments):
    clips = validate_plan([item(16, 24)], podcast_segments, DURATION, PARAMS)
    assert len(clips) == 1
    assert clips[0].endSeconds - clips[0].startSeconds >= PARAMS.min_duration - 0.5


def test_snaps_to_segment_boundaries(podcast_segments):
    # 17.2 is inside segment starting at 16.0 -> snapped (then lead-in padding applied).
    clips = validate_plan([item(17.2, 46.9)], podcast_segments, DURATION, PARAMS)
    assert abs(clips[0].startSeconds - (16.0 - 0.15)) < 1e-6
    assert abs(clips[0].endSeconds - (47.5 + 0.35)) < 1e-6


def test_overlapping_lower_score_clip_is_dropped(podcast_segments):
    clips = validate_plan([item(16, 50, 0.9, "a"), item(30, 70, 0.6, "b"), item(100, 140, 0.4, "c")], podcast_segments, DURATION, PARAMS)
    assert [c.title for c in clips] == ["a", "c"]


def test_ranked_and_limited_to_target(podcast_segments):
    items = [item(k * 64.0, k * 64.0 + 30, score=k / 10) for k in range(9)]
    clips = validate_plan(items, podcast_segments, DURATION, SelectionParams(3, 20, 60))
    assert len(clips) == 3
    assert [c.score for c in clips] == sorted([c.score for c in clips], reverse=True)


def test_scene_cut_snapping(podcast_segments):
    clips = validate_plan([item(16, 46)], podcast_segments, DURATION, PARAMS, scene_cuts=[16.1])
    assert clips[0].startSeconds == 16.1


def test_heuristic_prefers_hooks_and_skips_filler(podcast_segments):
    candidates = plan_heuristic(podcast_segments, DURATION, PARAMS)
    clips = validate_plan(candidates, podcast_segments, DURATION, PARAMS)
    _assert_valid(clips)
    assert len(clips) == PARAMS.target_clip_count
    top = clips[0]
    assert not top.hook.lower().startswith(("and", "so"))
    assert "Heuristic" in top.reason


def test_select_clips_without_llm_credentials_falls_back(podcast_segments):
    settings = Settings(clip_planner="llm", openai_api_key=None, azure_openai_endpoint=None)
    clips, planner = select_clips(podcast_segments, DURATION, PARAMS, settings)
    assert planner == "heuristic"
    _assert_valid(clips)
    assert len(clips) == 5


def test_parse_llm_items_is_lenient():
    content = json.dumps(
        {
            "clips": [
                {"startSeconds": 10, "endSeconds": 40, "title": "Good", "hook": "h", "reason": "r", "score": 0.8},
                {"startSeconds": "bad", "endSeconds": 40, "title": "Bad"},
                {"startSeconds": 50, "endSeconds": 90, "title": "x" * 300, "hook": "", "reason": "", "score": 7},
            ]
        }
    )
    items = parse_llm_items(content)
    assert [i.title[:4] for i in items] == ["Good", "xxxx"]
    assert items[1].score == 1.0
    assert parse_llm_items("not json") == []
