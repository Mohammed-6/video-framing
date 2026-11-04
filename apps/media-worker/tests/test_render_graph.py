"""Render filter-graph construction: framing fills, logo, music, intro/outro join."""

from __future__ import annotations

import re

from app.config import Settings
from app.pipeline.brand import ConcatPart, LogoSpec, MusicSpec, build_concat_args, logo_chain, music_chain
from app.pipeline.face_track import Face, Sample, fixed_plan, plan_framing
from app.pipeline.reframe import build_framing_graph
from app.pipeline.render import build_render_args

TIGHT = (1080 * 9 / 16) / 1920


def fc(args: list[str]) -> str:
    return args[args.index("-filter_complex") + 1]


def render(**kw):
    base = dict(
        start=10, end=40, src_w=1920, src_h=1080, crop_center_x=0.5, out_w=1080, out_h=1920,
        with_captions=True, has_audio=True, src_fps=30, settings=Settings(),
    )
    base.update(kw)
    return build_render_args("/src.mp4", **base)


def labels_balanced(graph: str):
    """Every [label] produced once and consumed once (except inputs like [0:v])."""
    produced, consumed = [], []
    for chain in graph.split(";"):
        heads = re.match(r"^((?:\[[^\]]+\])*)", chain).group(1)
        consumed += re.findall(r"\[([^\]]+)\]", heads)
        tail = re.search(r"((?:\[[^\]]+\])+)$", chain)
        produced += re.findall(r"\[([^\]]+)\]", tail.group(1)) if tail else []
    inputs = {c for c in consumed if re.fullmatch(r"\d+:[va]", c)}
    return sorted(set(consumed) - inputs - set(produced)), sorted(set(produced) - set(consumed))


# -- framing ---------------------------------------------------------------------

def test_static_crop_path():
    args = render()
    g = fc(args)
    assert g.startswith("[0:v]crop=w=606:h=1080:")
    assert "ass=captions.ass" in g and g.endswith("[speech]")
    assert args[args.index("-ss") + 1] == "10.000" and args[args.index("-t") + 1] == "30.000"
    assert "[vout]" in args and "[speech]" in args and "+faststart" in args


def test_no_audio_and_high_fps():
    args = render(has_audio=False, src_fps=120, with_captions=False)
    g = fc(args)
    assert "fps=60" in g and "ass=" not in g and "[0:a]" not in g
    assert "-c:a" not in args


def test_full_frame_blur_fill():
    graph, label = build_framing_graph(fixed_plan(10, 0.5, 1.0), 1920, 1080, 1080, 1920)
    assert label == "framed"
    assert "split[fg0][bg0]" in graph and "boxblur=" in graph
    assert "scale=134:240:force_original_aspect_ratio=increase,crop=134:240" in graph
    assert "[fs0]" in graph and "overlay=0:656" in graph  # 1080*1080/1920 -> 608 tall, centred
    assert labels_balanced(graph) == ([], ["framed"])


def test_full_frame_black_fill():
    graph, _ = build_framing_graph(fixed_plan(10, 0.5, 1.0), 1920, 1080, 1080, 1920, fill="black")
    assert "pad=1080:1920:0:656:black" in graph and "boxblur" not in graph


def test_tight_window_needs_no_fill():
    graph, _ = build_framing_graph(fixed_plan(10, 0.5, TIGHT), 1920, 1080, 1080, 1920)
    assert "boxblur" not in graph and "pad=" not in graph and "scale=1080:1920" in graph


def test_multi_level_graph_blur_and_gates():
    faces = [[Face(0.2, 0.4, 0.08, 0.13)]] * 16 + [[Face(0.15, 0.4, 0.08, 0.13), Face(0.85, 0.4, 0.08, 0.13)]] * 16
    samples = [Sample(t=i / 4, faces=f, motion=[0.05] * len(f)) for i, f in enumerate(faces)]
    plan = plan_framing(samples, 8.0, 0.5, TIGHT)
    graph, label = build_framing_graph(plan, 1920, 1080, 1080, 1920)
    assert re.search(r"\[0:v\]split=2\[s\d\]\[s\d\]", graph)
    assert graph.count("overlay=0:0:enable='") == 1
    assert graph.count("boxblur") == 1  # only the zoomed-out branch gets a blurred fill
    assert labels_balanced(graph) == ([], [label])


# -- logo & music -------------------------------------------------------------------

def test_logo_overlay_positions_and_opacity():
    tl = logo_chain(1, "cap", "branded", LogoSpec("/l.png", "top-left", 0.2, 0.5), 1080, 1920)
    assert "[1:v]scale=216:-1" in tl and "colorchannelmixer=aa=0.50" in tl and "overlay=x=54:y=76" in tl
    br = logo_chain(1, "cap", "branded", LogoSpec("/l.png", "bottom-right"), 1080, 1920)
    assert "x=main_w-overlay_w-54:y=main_h-overlay_h-115" in br


def test_music_ducked_under_speech():
    m = music_chain(2, 30.0, MusicSpec("/m.mp3", 0.2, duck=True), "speech", "aout")
    assert "[2:a]" in m and "volume=0.200" in m and "atrim=0:30.000" in m
    assert "sidechaincompress" in m and "amix=inputs=2:duration=first:normalize=0[aout]" in m
    plain = music_chain(2, 30.0, MusicSpec("/m.mp3", duck=False), "speech", "aout")
    assert "sidechaincompress" not in plain
    alone = music_chain(1, 30.0, MusicSpec("/m.mp3"), None, "aout")
    assert alone.endswith("[aout]") and "amix" not in alone


def test_render_with_logo_and_music_inputs_in_order():
    args = render(logo=LogoSpec("/logo.png"), music=MusicSpec("/song.mp3"))
    ins = [args[i + 1] for i, a in enumerate(args) if a == "-i"]
    assert ins == ["/src.mp4", "/logo.png", "/song.mp3"]
    assert args[args.index("/song.mp3") - 3 : args.index("/song.mp3")] == ["-stream_loop", "-1", "-i"]
    g = fc(args)
    assert "[1:v]" in g and "[2:a]" in g and "[aout]" in args
    unconsumed, dangling = labels_balanced(g)
    assert unconsumed == [] and sorted(dangling) == ["aout", "vout"]


def test_render_with_framing_and_blur():
    args = render(framing=fixed_plan(30, 0.5, 1.0), letterbox_fill="blur")
    g = fc(args)
    assert "boxblur" in g and "[framed]ass=captions.ass[cap]" in g and "[cap]format=yuv420p[vout]" in g


# -- intro/outro join ------------------------------------------------------------------

def test_concat_normalises_parts_and_lays_music_under_everything():
    parts = [ConcatPart("/intro.mp4", 3.0, False), ConcatPart("/main.mp4", 30.0, True), ConcatPart("/outro.mp4", 2.5, True)]
    args = build_concat_args(parts, out_w=1080, out_h=1920, fps=29.97, music=MusicSpec("/m.mp3"), settings=Settings())
    g = fc(args)
    assert g.count("force_original_aspect_ratio=decrease") == 3 and "fps=29.97" in g
    assert "anullsrc" in g  # silent intro gets a silent track so concat lines up
    assert "concat=n=3:v=1:a=1[vout][acat]" in g
    assert "atrim=0:35.500" in g  # music spans intro + clip + outro
    assert args[args.index("-map") + 1] == "[vout]" and "[aout]" in args
    unconsumed, dangling = labels_balanced(g)
    assert unconsumed == [] and sorted(dangling) == ["aout", "vout"]
