"""Speech-to-text with word-level timestamps (needed for animated captions)."""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable

from ..config import Settings
from ..errors import PipelineError
from ..models import Transcript, TranscriptSegment, TranscriptWord
from .extract_audio import encode_compressed_chunk

log = logging.getLogger(__name__)

ProgressFn = Callable[[float], None]

_model = None
_model_lock = threading.Lock()


def _whisper_model(settings: Settings):
    """Load once per process; model loading takes seconds and hundreds of MB."""
    global _model
    with _model_lock:
        if _model is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:  # pragma: no cover
                raise PipelineError("transcriber_unavailable", "faster-whisper is not installed") from exc
            log.info("loading whisper model %s on %s", settings.whisper_model, settings.whisper_device)
            _model = WhisperModel(
                settings.whisper_model, device=settings.whisper_device, compute_type=settings.whisper_compute_type
            )
        return _model


def transcribe_faster_whisper(
    audio_path: Path, duration: float, language: str | None, settings: Settings, on_progress: ProgressFn
) -> Transcript:
    model = _whisper_model(settings)
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=5,
    )
    segments: list[TranscriptSegment] = []
    for i, seg in enumerate(segments_iter):  # generator: transcription happens while iterating
        words = [
            TranscriptWord(start=round(w.start, 3), end=round(w.end, 3), word=w.word.strip(), probability=round(w.probability, 3))
            for w in (seg.words or [])
            if w.word.strip()
        ]
        segments.append(
            TranscriptSegment(id=i, start=round(seg.start, 3), end=round(seg.end, 3), text=seg.text.strip(), words=words)
        )
        if duration > 0:
            on_progress(min(1.0, seg.end / duration))
    return Transcript(language=info.language or language or "und", provider=f"faster-whisper:{settings.whisper_model}", segments=segments)


OPENAI_CHUNK_SECONDS = 20 * 60  # 20 min @ 48 kbps ≈ 7 MB, under the 25 MB API limit


def transcribe_openai(
    audio_path: Path, duration: float, language: str | None, settings: Settings, on_progress: ProgressFn
) -> Transcript:
    from openai import OpenAI

    if not settings.openai_api_key:
        raise PipelineError("transcriber_unavailable", "OPENAI_API_KEY is required for TRANSCRIBE_PROVIDER=openai")
    client = OpenAI(api_key=settings.openai_api_key, base_url=settings.openai_base_url or None)
    segments: list[TranscriptSegment] = []
    detected_language = language
    offset = 0.0
    chunk_idx = 0
    while offset < duration:
        span = min(OPENAI_CHUNK_SECONDS, duration - offset)
        chunk = encode_compressed_chunk(audio_path, audio_path.with_name(f"chunk_{chunk_idx}.mp3"), offset, span)
        with chunk.open("rb") as fh:
            resp = client.audio.transcriptions.create(
                model="whisper-1",
                file=fh,
                language=language,
                response_format="verbose_json",
                timestamp_granularities=["word", "segment"],
            )
        detected_language = detected_language or getattr(resp, "language", None)
        words = [
            TranscriptWord(start=round(w.start + offset, 3), end=round(w.end + offset, 3), word=w.word.strip())
            for w in (resp.words or [])
        ]
        for seg in resp.segments or []:
            s, e = seg.start + offset, seg.end + offset
            seg_words = [w for w in words if w.start >= s - 0.05 and w.end <= e + 0.05]
            segments.append(
                TranscriptSegment(id=len(segments), start=round(s, 3), end=round(e, 3), text=seg.text.strip(), words=seg_words)
            )
        offset += span
        chunk_idx += 1
        on_progress(min(1.0, offset / duration))
    lang = _normalize_language(detected_language)
    return Transcript(language=lang, provider="openai:whisper-1", segments=segments)


def _normalize_language(lang: str | None) -> str:
    """The OpenAI API returns full names ('english'); store ISO-ish codes when we can."""
    names = {"english": "en", "spanish": "es", "french": "fr", "german": "de", "portuguese": "pt", "hindi": "hi", "bengali": "bn"}
    if not lang:
        return "und"
    return names.get(lang.lower(), lang.lower()[:8])


def transcribe(
    audio_path: Path, duration: float, language: str | None, settings: Settings, on_progress: ProgressFn
) -> Transcript:
    if settings.transcribe_provider == "openai":
        t = transcribe_openai(audio_path, duration, language, settings, on_progress)
    else:
        t = transcribe_faster_whisper(audio_path, duration, language, settings, on_progress)
    if not any(s.text for s in t.segments):
        raise PipelineError("no_speech", "No speech was detected in the video, so clips cannot be selected")
    return t
