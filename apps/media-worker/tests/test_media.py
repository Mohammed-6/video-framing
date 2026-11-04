from __future__ import annotations

import pytest

from app.config import Settings
from app.errors import PipelineError
from app.models import TranscriptWord
from app.pipeline.captions import ass_color, ass_time, build_ass, escape_ass, paginate, relative_words
from app.pipeline.probe import parse_probe
from app.pipeline.reframe import compute_crop
from app.pipeline.render import build_render_args


# -- reframe ------------------------------------------------------------------

def test_crop_landscape_center():
    box = compute_crop(1920, 1080, 0.5)
    assert (box.w, box.h) == (606, 1080)
    assert box.x == (1920 - 606) // 2 - ((1920 - 606) // 2) % 2
    assert box.w % 2 == 0 and box.x % 2 == 0


@pytest.mark.parametrize("cx,expected_x", [(0.0, 0), (1.0, 1920 - 606)])
def test_crop_clamped_to_edges(cx, expected_x):
    assert compute_crop(1920, 1080, cx).x == expected_x


def test_crop_already_vertical_source():
    box = compute_crop(1080, 1920, 0.5)
    assert (box.x, box.y, box.w, box.h) == (0, 0, 1080, 1920)


def test_crop_tall_source_crops_vertically():
    box = compute_crop(1000, 2400, 0.5)
    assert box.w == 1000 and box.h == 1776 and box.y == (2400 - 1776) // 2


# -- probe --------------------------------------------------------------------

def _probe_data(rotation=None, audio=True):
    v = {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001"}
    if rotation is not None:
        v["side_data_list"] = [{"rotation": rotation}]
    streams = [v] + ([{"codec_type": "audio"}] if audio else [])
    return {"streams": streams, "format": {"duration": "123.45"}}


def test_probe_parses_basic_info():
    info = parse_probe(_probe_data())
    assert (info.width, info.height, info.fps, info.has_audio) == (1920, 1080, 29.97, True)
    assert info.duration_seconds == 123.45


def test_probe_applies_rotation():
    info = parse_probe(_probe_data(rotation=-90))
    assert (info.width, info.height) == (1080, 1920)


def test_probe_requires_video():
    with pytest.raises(PipelineError) as e:
        parse_probe({"streams": [{"codec_type": "audio"}], "format": {"duration": "5"}})
    assert e.value.code == "no_video_stream"


# -- captions -----------------------------------------------------------------

def words(*spec):
    return [TranscriptWord(start=s, end=e, word=w) for s, e, w in spec]


def test_ass_helpers():
    assert ass_color("#FFE14D") == "&H004DE1FF"
    assert ass_color("#000000", 0x80) == "&H80000000"
    assert ass_time(3661.236) == "1:01:01.24"
    assert escape_ass("a{\\b}c") == "a(⧵b)c"


def test_relative_words_shift_and_clip():
    ws = words((9.0, 9.9, "before"), (10.0, 10.5, "hello"), (10.6, 11.0, "world"), (30.0, 30.5, "after"))
    rel = relative_words(ws, 10.0, 20.0)
    assert [w.word for w in rel] == ["hello", "world"]
    assert rel[0].start == 0.0 and rel[1].start == 0.6


def test_paginate_breaks_on_sentence_and_gaps():
    ws = words((0, 0.3, "Hi."), (0.4, 0.6, "this"), (0.7, 0.9, "is"), (2.0, 2.2, "late"))
    pages = paginate(ws, max_words=4, max_chars=30)
    assert [[w.word for w in p.words] for p in pages] == [["Hi."], ["this", "is"], ["late"]]


@pytest.mark.parametrize("style", ["bold_pop", "karaoke", "minimal", "boxed"])
def test_build_ass_styles(style):
    ws = words((0.0, 0.4, "Why"), (0.45, 0.8, "do"), (0.85, 1.3, "startups"), (1.35, 1.8, "fail?"))
    ass = build_ass(ws, clip_duration=5, style=style, width=1080, height=1920, watermark="My Brand")
    assert "PlayResX: 1080" in ass and "Style: Caption," in ass
    dialogue = [l for l in ass.splitlines() if l.startswith("Dialogue:") and ",Caption," in l]
    assert dialogue, style
    assert any(",Watermark,," in l and "My Brand" in l for l in ass.splitlines())
    if style == "bold_pop":
        assert len(dialogue) == 4 and "STARTUPS" in ass  # one event per active word, uppercased
    if style == "karaoke":
        assert "\\kf" in dialogue[0]


def test_build_ass_none_style_only_watermark():
    ass = build_ass(words((0, 1, "hi")), clip_duration=3, style="none", width=720, height=1280, watermark="wm")
    assert not any(",Caption," in l for l in ass.splitlines() if l.startswith("Dialogue:"))
    assert "Style: Caption" not in ass
