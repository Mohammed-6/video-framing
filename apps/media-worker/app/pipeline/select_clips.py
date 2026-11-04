"""Highlight selection: propose clip segments from the transcript, then validate them.

Two planners share one validator:
  * `llm`       — an OpenAI-compatible chat model (OpenAI or Azure OpenAI) with structured JSON output.
  * `heuristic` — deterministic text scoring; runs with no API key and is the fallback if the LLM fails.

Every proposed clip is validated against the source duration, min/max duration and overlap
rules, and snapped to speech boundaries. `score` is a ranking heuristic, not a virality prediction.
"""

from __future__ import annotations

import bisect
import json
import logging
import math
import re
from dataclasses import dataclass
from typing import Iterable, Sequence

from ..config import Settings
from ..errors import PipelineError
from ..models import ClipPlanItem, TranscriptSegment
from ..models.clip_plan import CLIP_PLAN_JSON_SCHEMA

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class SelectionParams:
    target_clip_count: int = 5
    min_duration: float = 20.0
    max_duration: float = 60.0


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

BOUNDARY_SNAP_TOLERANCE = 2.0  # seconds to look for a sentence boundary
SCENE_SNAP_TOLERANCE = 0.5
LEAD_IN = 0.15  # breathing room so the first word isn't clipped
TAIL_OUT = 0.35
MAX_OVERLAP_SECONDS = 1.0


def _snap(value: float, candidates: Sequence[float], tolerance: float) -> float:
    """Return the candidate closest to `value` within `tolerance`, else `value`."""
    if not candidates:
        return value
    i = bisect.bisect_left(candidates, value)
    best = value
    best_d = tolerance + 1e-9
    for j in (i - 1, i):
        if 0 <= j < len(candidates):
            d = abs(candidates[j] - value)
            if d <= best_d:
                best, best_d = candidates[j], d
    return best


def _overlap(a: ClipPlanItem, b: ClipPlanItem) -> float:
    return max(0.0, min(a.endSeconds, b.endSeconds) - max(a.startSeconds, b.startSeconds))


def _fallback_title(start: float) -> str:
    m, s = divmod(int(start), 60)
    return f"Highlight at {m}:{s:02d}"


def validate_plan(
    items: Iterable[ClipPlanItem],
    segments: Sequence[TranscriptSegment],
    duration: float,
    params: SelectionParams,
    scene_cuts: Sequence[float] = (),
) -> list[ClipPlanItem]:
    """Clamp, snap, length-fix, de-overlap and rank proposed clips. Invalid ones are dropped."""
    seg_starts = sorted(s.start for s in segments)
    seg_ends = sorted(s.end for s in segments)
    cuts = sorted(scene_cuts)
    min_d, max_d = params.min_duration, params.max_duration

    cleaned: list[ClipPlanItem] = []
    for it in items:
        s, e = float(it.startSeconds), float(it.endSeconds)
        if not (math.isfinite(s) and math.isfinite(e)):
            continue
        s, e = max(0.0, min(s, duration)), max(0.0, min(e, duration))
        if e - s <= 0.5:
            continue

        # 1. Snap to sentence/segment boundaries so clips start and end on complete thoughts.
        s = _snap(s, seg_starts, BOUNDARY_SNAP_TOLERANCE)
        e = _snap(e, seg_ends, BOUNDARY_SNAP_TOLERANCE)

        # 2. Fix length using segment ends inside the allowed window.
        if e - s > max_d:
            inside = [x for x in seg_ends if s + min_d <= x <= s + max_d]
            e = inside[-1] if inside else s + max_d
        if e - s < min_d:
            later = [x for x in seg_ends if s + min_d <= x <= min(s + max_d, duration)]
            if later:
                e = later[0]
            elif duration - s >= min_d:
                e = s + min_d
            else:
                continue

        # 3. Padding, then scene-cut snapping (a cut just inside the clip start is a cleaner open).
        s = max(0.0, s - LEAD_IN)
        e = min(duration, e + TAIL_OUT)
        s = _snap(s, cuts, SCENE_SNAP_TOLERANCE)
        e = _snap(e, cuts, SCENE_SNAP_TOLERANCE)

        length = e - s
        if length < min_d - 0.5 or length > max_d + 0.5 or e > duration + 1e-6:
            continue

        title = re.sub(r"\s+", " ", it.title or "").strip()[:100] or _fallback_title(s)
        cleaned.append(
            ClipPlanItem(
                startSeconds=round(s, 3),
                endSeconds=round(e, 3),
                title=title,
                hook=(it.hook or "").strip()[:300],
                reason=(it.reason or "").strip()[:500],
                score=round(min(1.0, max(0.0, float(it.score))), 3),
            )
        )

    cleaned.sort(key=lambda c: c.score, reverse=True)
    accepted: list[ClipPlanItem] = []
    for c in cleaned:
        if all(_overlap(c, a) <= MAX_OVERLAP_SECONDS for a in accepted):
            accepted.append(c)
        if len(accepted) >= params.target_clip_count:
            break
    return accepted


# ---------------------------------------------------------------------------
# Heuristic planner
# ---------------------------------------------------------------------------

HOOK_WORDS = {
    "secret", "mistake", "mistakes", "never", "always", "biggest", "worst", "best", "truth", "why", "how",
    "nobody", "everyone", "stop", "wrong", "surprising", "crazy", "insane", "important", "lesson", "realized",
    "problem", "fail", "failed", "money", "free", "hack", "simple", "actually", "story",
}
EMOTION_WORDS = {
    "love", "hate", "amazing", "incredible", "terrible", "afraid", "scared", "excited", "shocked", "unbelievable",
    "huge", "massive", "honestly", "literally", "crazy", "insane", "wow",
}
FILLERS = {"um", "uh", "erm", "hmm", "like", "basically"}
WEAK_OPENERS = {"and", "but", "so", "because", "or", "then", "also", "which"}
HOOK_OPENER_RE = re.compile(
    r"^(here'?s|this is|the (biggest|real|secret|truth|problem)|why|how|what|stop|never|if you|you (need|should|have)|most people)",
    re.I,
)
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
WORD_RE = re.compile(r"[a-z0-9']+")


def _first_sentence(text: str) -> str:
    return SENTENCE_RE.split(text.strip(), maxsplit=1)[0].strip()


def _make_title(sentence: str) -> str:
    words = sentence.rstrip(".!?,;:").split()
    title = " ".join(words[:9])
    if len(words) > 9:
        title += "…"
    return (title[:1].upper() + title[1:])[:100] if title else ""


def plan_heuristic(
    segments: Sequence[TranscriptSegment], duration: float, params: SelectionParams
) -> list[ClipPlanItem]:
    segs = [s for s in segments if s.text.strip()]
    if not segs:
        return []
    ideal = min(params.max_duration, max(params.min_duration, (params.min_duration + params.max_duration) / 2))

    total_words = sum(len(s.text.split()) for s in segs)
    speech_span = max(1.0, sum(s.end - s.start for s in segs))
    base_density = total_words / speech_span

    raw: list[tuple[float, ClipPlanItem]] = []
    n = len(segs)
    for i in range(n):
        start = segs[i].start
        j = i
        while j < n - 1 and segs[j].end - start < ideal:
            j += 1
        while j > i and segs[j].end - start > params.max_duration:
            j -= 1
        end = segs[j].end
        length = end - start
        if length < params.min_duration or length > params.max_duration:
            continue

        window = segs[i : j + 1]
        text = " ".join(s.text.strip() for s in window)
        tokens = WORD_RE.findall(text.lower())
        if len(tokens) < 8:
            continue
        opener = _first_sentence(window[0].text)
        opener_tokens = WORD_RE.findall(opener.lower())

        signals: list[str] = []
        score = 0.0
        if "?" in opener:
            score += 1.0
            signals.append("opens with a question")
        if HOOK_OPENER_RE.search(opener):
            score += 0.8
            signals.append("strong hook phrasing")
        hook_hits = len(set(opener_tokens) & HOOK_WORDS)
        if hook_hits:
            score += min(1.2, 0.4 * hook_hits)
            signals.append("attention words in the opening line")
        if any(t.isdigit() for t in opener_tokens):
            score += 0.4
            signals.append("specific numbers")
        if opener_tokens and opener_tokens[0] in WEAK_OPENERS:
            score -= 0.8  # probably starts mid-thought
        emotion = sum(1 for t in tokens if t in EMOTION_WORDS) + text.count("!")
        if emotion:
            score += min(1.0, 0.25 * emotion)
            signals.append("emotional emphasis")
        density = len(tokens) / max(1.0, length)
        density_ratio = density / max(0.1, base_density)
        score += max(-0.6, min(0.8, (density_ratio - 1.0) * 1.5))
        if density_ratio > 1.1:
            signals.append("high speech energy")
        filler_ratio = sum(1 for t in tokens if t in FILLERS) / len(tokens)
        score -= min(1.0, filler_ratio * 8)
        if window[-1].text.strip().endswith((".", "!", "?")):
            score += 0.5
            signals.append("ends on a complete sentence")

        raw.append(
            (
                score,
                ClipPlanItem(
                    startSeconds=start,
                    endSeconds=end,
                    title=_make_title(opener) or _fallback_title(start),
                    hook=opener[:300],
                    reason=("Heuristic: " + ", ".join(signals))[:500] if signals else "Heuristic: self-contained segment",
                    score=0.0,
                ),
            )
        )

    if not raw:
        return []
    lo = min(r[0] for r in raw)
    hi = max(r[0] for r in raw)
    span = hi - lo or 1.0
    # Map to [0.30, 0.90]: heuristic scores should not look as confident as a model's.
    return [item.model_copy(update={"score": round(0.3 + 0.6 * (s - lo) / span, 3)}) for s, item in raw]


# ---------------------------------------------------------------------------
# LLM planner
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert short-form video editor who finds the most engaging, \
self-contained moments in long-form videos for YouTube Shorts, Instagram Reels and TikTok.

Pick moments that:
- open with a strong hook in the first 3 seconds (a question, bold claim, surprising fact, or tension)
- are understandable without the rest of the video
- deliver a payoff: an insight, punchline, story resolution or clear takeaway
- start and end on sentence boundaries (use the timestamps provided)

Avoid intros, outros, sponsor reads, housekeeping and moments that depend on visuals not described in speech.
Write titles under 60 characters in the transcript's language. `hook` quotes or closely paraphrases the opening line.
`reason` briefly explains why it works. `score` in [0,1] ranks your confidence relative to the other clips."""


def _format_transcript(segments: Sequence[TranscriptSegment]) -> str:
    return "\n".join(f"[{s.start:.1f}-{s.end:.1f}] {s.text.strip()}" for s in segments if s.text.strip())


def _windows(segments: Sequence[TranscriptSegment], max_chars: int) -> list[list[TranscriptSegment]]:
    out: list[list[TranscriptSegment]] = []
    cur: list[TranscriptSegment] = []
    size = 0
    for s in segments:
        line = len(s.text) + 20
        if cur and size + line > max_chars:
            out.append(cur)
            cur, size = [], 0
        cur.append(s)
        size += line
    if cur:
        out.append(cur)
    return out


def _llm_client(settings: Settings):
    if settings.azure_openai_endpoint:
        from openai import AzureOpenAI

        if not (settings.azure_openai_api_key and settings.azure_openai_deployment):
            raise PipelineError("planner_unavailable", "Azure OpenAI endpoint set but key/deployment missing")
        client = AzureOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            api_key=settings.azure_openai_api_key,
            api_version=settings.azure_openai_api_version,
            timeout=settings.llm_timeout_seconds,
            max_retries=2,
        )
        return client, settings.azure_openai_deployment
    if settings.openai_api_key:
        from openai import OpenAI

        client = OpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url or None,
            timeout=settings.llm_timeout_seconds,
            max_retries=2,
        )
        return client, settings.openai_model
    raise PipelineError("planner_unavailable", "No LLM credentials configured")


def parse_llm_items(content: str) -> list[ClipPlanItem]:
    """Lenient parsing: keep every individually valid clip instead of rejecting the whole plan."""
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        log.warning("LLM returned non-JSON content")
        return []
    items: list[ClipPlanItem] = []
    for raw in data.get("clips", []) if isinstance(data, dict) else []:
        if not isinstance(raw, dict):
            continue
        try:
            items.append(
                ClipPlanItem(
                    startSeconds=max(0.0, float(raw.get("startSeconds", -1))),
                    endSeconds=float(raw.get("endSeconds", 0)),
                    title=str(raw.get("title") or "Untitled clip")[:100],
                    hook=str(raw.get("hook") or "")[:300],
                    reason=str(raw.get("reason") or "")[:500],
                    score=min(1.0, max(0.0, float(raw.get("score", 0.5)))),
                )
            )
        except (TypeError, ValueError):
            continue
    return items


def plan_with_llm(
    segments: Sequence[TranscriptSegment], duration: float, params: SelectionParams, settings: Settings
) -> list[ClipPlanItem]:
    client, model = _llm_client(settings)
    windows = _windows(segments, max_chars=60_000)
    per_window = max(3, math.ceil(params.target_clip_count * 1.5 / len(windows)) + 1)
    proposals: list[ClipPlanItem] = []
    for idx, window in enumerate(windows):
        user = (
            f"Video duration: {duration:.1f}s. Transcript part {idx + 1} of {len(windows)}.\n"
            f"Propose up to {per_window} clips, each between {params.min_duration:.0f}s and "
            f"{params.max_duration:.0f}s long, that do not overlap.\n"
            "Timestamps are [start-end] in seconds from the beginning of the video.\n\n"
            f"TRANSCRIPT:\n{_format_transcript(window)}"
        )
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
            response_format={"type": "json_schema", "json_schema": CLIP_PLAN_JSON_SCHEMA},
            temperature=0.4,
        )
        proposals.extend(parse_llm_items(resp.choices[0].message.content or "{}"))
    return proposals


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def select_clips(
    segments: Sequence[TranscriptSegment],
    duration: float,
    params: SelectionParams,
    settings: Settings,
    scene_cuts: Sequence[float] = (),
) -> tuple[list[ClipPlanItem], str]:
    """Returns (validated clips, planner name actually used)."""
    planner = "heuristic"
    proposals: list[ClipPlanItem] = []
    if settings.clip_planner == "llm":
        try:
            proposals = plan_with_llm(segments, duration, params, settings)
            planner = "llm"
        except Exception as exc:  # config/network/model errors: degrade instead of failing the job
            log.exception("LLM planning failed, falling back to heuristic: %s", exc)

    clips = validate_plan(proposals, segments, duration, params, scene_cuts) if proposals else []
    if len(clips) < params.target_clip_count:
        # Top up with heuristic candidates that don't collide with what we already have.
        heuristic = validate_plan(plan_heuristic(segments, duration, params), segments, duration, params, scene_cuts)
        for h in heuristic:
            if len(clips) >= params.target_clip_count:
                break
            if all(_overlap(h, c) <= MAX_OVERLAP_SECONDS for c in clips):
                clips.append(h)
        if planner == "llm" and len(clips) and any(c.reason.startswith("Heuristic") for c in clips):
            planner = "llm+heuristic"
    if not clips:
        raise PipelineError(
            "no_clips_found",
            f"Couldn't find any {params.min_duration:.0f}-{params.max_duration:.0f}s segments with enough speech. "
            "Try a shorter minimum duration.",
        )
    return clips, planner
