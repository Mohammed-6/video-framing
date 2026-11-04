from __future__ import annotations

import pytest

from app.models import TranscriptSegment, TranscriptWord


def make_segments(spec: list[tuple[float, float, str]]) -> list[TranscriptSegment]:
    segs = []
    for i, (start, end, text) in enumerate(spec):
        tokens = text.split()
        step = (end - start) / max(1, len(tokens))
        words = [
            TranscriptWord(start=round(start + k * step, 3), end=round(start + (k + 1) * step, 3), word=t)
            for k, t in enumerate(tokens)
        ]
        segs.append(TranscriptSegment(id=i, start=start, end=end, text=text, words=words))
    return segs


@pytest.fixture
def podcast_segments() -> list[TranscriptSegment]:
    """~10 minutes of synthetic speech: 8-second segments with varied content."""
    lines = [
        "Welcome back to the show, today we have a great guest.",
        "Thanks for having me, it's great to be here.",
        "Why do most startups fail in their first year?",
        "The biggest mistake founders make is building before talking to customers.",
        "They spend months on a product nobody actually wants.",
        "I failed twice before I learned this lesson the hard way.",
        "So you have to validate the problem first, that's the secret.",
        "And um, like, basically, you know, it's um, kind of like that.",
        "Here's the truth about fundraising that nobody tells you.",
        "Investors bet on momentum, not on ideas, and that's huge.",
        "If you have ten paying customers you have leverage!",
        "That changed everything for us, honestly it was incredible.",
    ]
    spec = []
    t = 0.0
    for k in range(75):
        text = lines[k % len(lines)]
        spec.append((t, t + 7.5, text))
        t += 8.0
    return make_segments(spec)
