"""Styled, animated captions as an ASS subtitle file, burned in by ffmpeg/libass.

ASS gives us per-word colour/scale animation, outlines, boxes and karaoke fills
without compositing frames in Python, and renders identically everywhere libass runs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal, Sequence

from ..models import TranscriptWord

CaptionStyleName = Literal["bold_pop", "karaoke", "minimal", "boxed", "none"]
Mode = Literal["word_highlight", "karaoke", "static"]


@dataclass(frozen=True)
class CaptionTheme:
    mode: Mode
    font_size: int  # at PlayResY = 1920
    text_color: str  # "#RRGGBB"
    highlight_color: str
    outline_color: str = "#000000"
    outline: float = 0.0
    shadow: float = 0.0
    border_style: int = 1  # 1 = outline + shadow, 3 = opaque box
    back_color: str = "#000000"
    back_alpha: int = 0x80
    uppercase: bool = False
    bold: bool = True
    max_words: int = 4
    max_chars: int = 24
    pop_scale: int = 100  # % scale applied to the active word


THEMES: dict[str, CaptionTheme] = {
    "bold_pop": CaptionTheme(
        mode="word_highlight", font_size=96, text_color="#FFFFFF", highlight_color="#FFE14D",
        outline=6, shadow=2, uppercase=True, max_words=3, max_chars=18, pop_scale=112,
    ),
    "karaoke": CaptionTheme(
        mode="karaoke", font_size=84, text_color="#FFFFFF", highlight_color="#3DF2A6",
        outline=5, shadow=1, max_words=5, max_chars=28,
    ),
    "minimal": CaptionTheme(
        mode="static", font_size=66, text_color="#FFFFFF", highlight_color="#FFFFFF",
        outline=0, shadow=3, bold=False, max_words=8, max_chars=42,
    ),
    "boxed": CaptionTheme(
        mode="word_highlight", font_size=70, text_color="#FFFFFF", highlight_color="#FFE14D",
        outline=14, shadow=0, border_style=3, back_color="#000000", back_alpha=0x60, max_words=5, max_chars=30,
    ),
}


@dataclass
class Page:
    words: list[TranscriptWord] = field(default_factory=list)

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return self.words[-1].end


def ass_color(hex_rgb: str, alpha: int = 0) -> str:
    """'#RRGGBB' -> '&HAABBGGRR' (ASS alpha: 00 opaque, FF transparent)."""
    h = hex_rgb.lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", h):
        raise ValueError(f"invalid colour {hex_rgb!r}")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def escape_ass(text: str) -> str:
    """Neutralise characters that would start override blocks or escapes."""
    return (
        text.replace("\\", "⧵")
        .replace("{", "(")
        .replace("}", ")")
        .replace("\r", " ")
        .replace("\n", " ")
    )


def relative_words(words: Sequence[TranscriptWord], clip_start: float, clip_end: float) -> list[TranscriptWord]:
    """Shift words to clip-relative time and drop/clamp those outside the clip."""
    dur = clip_end - clip_start
    out: list[TranscriptWord] = []
    for w in sorted(words, key=lambda w: w.start):
        s, e = w.start - clip_start, w.end - clip_start
        if e <= 0.02 or s >= dur - 0.02 or not w.word.strip():
            continue
        s, e = max(0.0, s), min(dur, max(e, s + 0.05))
        if out and s < out[-1].end:  # keep strictly ordered, non-overlapping
            s = out[-1].end
            e = max(e, s + 0.05)
        out.append(TranscriptWord(start=round(s, 3), end=round(e, 3), word=w.word.strip()))
    return out


def paginate(words: Sequence[TranscriptWord], max_words: int, max_chars: int, max_gap: float = 0.7) -> list[Page]:
    pages: list[Page] = []
    cur = Page()
    for w in words:
        if cur.words:
            chars = sum(len(x.word) + 1 for x in cur.words) + len(w.word)
            gap = w.start - cur.words[-1].end
            sentence_end = cur.words[-1].word.endswith((".", "?", "!"))
            if len(cur.words) >= max_words or chars > max_chars or gap > max_gap or sentence_end:
                pages.append(cur)
                cur = Page()
        cur.words.append(w)
    if cur.words:
        pages.append(cur)
    return pages


def _page_bounds(pages: Sequence[Page], i: int, clip_duration: float) -> tuple[float, float]:
    """Hold each page until the next one starts if the gap is short, to avoid flicker."""
    start = pages[i].start
    end = pages[i].end
    nxt = pages[i + 1].start if i + 1 < len(pages) else clip_duration
    end = nxt if nxt - end < 0.4 else min(end + 0.3, nxt)
    return start, min(end, clip_duration)


def build_ass(
    words: Sequence[TranscriptWord],
    *,
    clip_duration: float,
    style: CaptionStyleName,
    width: int,
    height: int,
    font: str = "DejaVu Sans",
    highlight_color: str | None = None,
    position: Literal["bottom", "middle"] = "bottom",
    watermark: str | None = None,
) -> str:
    """`words` must already be clip-relative (see `relative_words`)."""
    scale = height / 1920
    theme = THEMES.get(style)
    margin_lr = int(width * 0.08)
    margin_v = int(height * 0.22) if position == "bottom" else 0
    alignment = 2 if position == "bottom" else 5

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
    ]
    hl = highlight_color or (theme.highlight_color if theme else "#FFFFFF")
    if theme:
        # Karaoke fills from SecondaryColour to PrimaryColour, so primary = highlight there.
        primary = hl if theme.mode == "karaoke" else theme.text_color
        secondary = theme.text_color if theme.mode == "karaoke" else hl
        back = ass_color(theme.back_color, theme.back_alpha) if theme.border_style == 3 else ass_color("#000000", 0x80)
        outline_color = back if theme.border_style == 3 else ass_color(theme.outline_color)
        lines.append(
            f"Style: Caption,{font},{round(theme.font_size * scale)},{ass_color(primary)},{ass_color(secondary)},"
            f"{outline_color},{back},{-1 if theme.bold else 0},0,0,0,100,100,0,0,{theme.border_style},"
            f"{theme.outline * scale:.1f},{theme.shadow * scale:.1f},{alignment},{margin_lr},{margin_lr},{margin_v},1"
        )
    lines.append(
        f"Style: Watermark,{font},{round(40 * scale)},{ass_color('#FFFFFF', 0x40)},{ass_color('#FFFFFF')},"
        f"{ass_color('#000000', 0x80)},{ass_color('#000000', 0xFF)},-1,0,0,0,100,100,0,0,1,"
        f"{2 * scale:.1f},0,9,{int(width * 0.05)},{int(width * 0.05)},{int(height * 0.04)},1"
    )
    lines += [
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    if watermark:
        lines.append(f"Dialogue: 1,{ass_time(0)},{ass_time(clip_duration)},Watermark,,0,0,0,,{escape_ass(watermark)}")

    if theme:
        pages = paginate(words, theme.max_words, theme.max_chars)
        hl_tag = ass_color(hl)
        base_tag = ass_color(theme.text_color)

        def fmt(word: str) -> str:
            return escape_ass(word.upper() if theme.uppercase else word)

        for i, page in enumerate(pages):
            p_start, p_end = _page_bounds(pages, i, clip_duration)
            if p_end - p_start < 0.05:
                continue
            if theme.mode == "static":
                text = " ".join(fmt(w.word) for w in page.words)
                lines.append(f"Dialogue: 0,{ass_time(p_start)},{ass_time(p_end)},Caption,,0,0,0,,{text}")
            elif theme.mode == "karaoke":
                parts = []
                cursor = p_start
                for w in page.words:
                    lead = int(round((w.start - cursor) * 100))
                    if lead > 0:
                        parts.append(f"{{\\k{lead}}}")
                    parts.append(f"{{\\kf{max(1, int(round((w.end - w.start) * 100)))}}}{fmt(w.word)} ")
                    cursor = w.end
                lines.append(f"Dialogue: 0,{ass_time(p_start)},{ass_time(p_end)},Caption,,0,0,0,,{''.join(parts).rstrip()}")
            else:  # word_highlight: one event per active word, the whole page visible each time
                for k, active in enumerate(page.words):
                    ev_start = p_start if k == 0 else active.start
                    ev_end = page.words[k + 1].start if k + 1 < len(page.words) else p_end
                    if ev_end - ev_start < 0.02:
                        continue
                    rendered = []
                    for j, w in enumerate(page.words):
                        if j == k:
                            pop = (
                                f"\\fscx{theme.pop_scale}\\fscy{theme.pop_scale}"
                                if theme.pop_scale != 100
                                else ""
                            )
                            rendered.append(f"{{\\c{hl_tag}{pop}}}{fmt(w.word)}{{\\c{base_tag}\\fscx100\\fscy100}}")
                        else:
                            rendered.append(fmt(w.word))
                    lines.append(
                        f"Dialogue: 0,{ass_time(ev_start)},{ass_time(ev_end)},Caption,,0,0,0,,{' '.join(rendered)}"
                    )

    return "\n".join(lines) + "\n"
