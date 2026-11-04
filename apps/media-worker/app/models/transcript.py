from __future__ import annotations

from pydantic import BaseModel, Field


class TranscriptWord(BaseModel):
    start: float
    end: float
    word: str
    probability: float | None = None


class TranscriptSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    words: list[TranscriptWord] = Field(default_factory=list)


class Transcript(BaseModel):
    language: str
    provider: str
    segments: list[TranscriptSegment]

    def words_between(self, start: float, end: float) -> list[TranscriptWord]:
        """Words overlapping [start, end]. Segments without word timing are split evenly."""
        out: list[TranscriptWord] = []
        for seg in self.segments:
            if seg.end < start or seg.start > end:
                continue
            words = seg.words or approximate_words(seg)
            out.extend(w for w in words if w.end > start and w.start < end)
        return out

    def to_storage_json(self) -> dict:
        return {"segments": [s.model_dump(exclude_none=True) for s in self.segments]}


def approximate_words(seg: TranscriptSegment) -> list[TranscriptWord]:
    """Distribute a segment's duration across its words proportionally to their length."""
    tokens = seg.text.split()
    if not tokens:
        return []
    total_chars = sum(len(t) for t in tokens)
    span = max(seg.end - seg.start, 0.01)
    t = seg.start
    words: list[TranscriptWord] = []
    for tok in tokens:
        d = span * len(tok) / total_chars
        words.append(TranscriptWord(start=t, end=t + d, word=tok))
        t += d
    return words
