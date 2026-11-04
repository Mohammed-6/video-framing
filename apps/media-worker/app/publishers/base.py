from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

import httpx

from ..config import Settings
from ..errors import PipelineError


class PublishError(PipelineError):
    """`committed=True` means the platform may already have the post — never auto-retry those."""

    def __init__(self, code: str, message: str, *, retryable: bool = False, committed: bool = False):
        if committed:
            retryable = False
            message = f"{message} (the post may already be live — check the platform before retrying)"
        super().__init__(code, message, retryable=retryable)
        self.committed = committed


@dataclass
class PublishContext:
    video_path: Path
    title: str
    description: str
    config: dict
    credentials: dict
    settings: Settings
    on_progress: Callable[[float], None] = lambda _f: None
    # Publishers call this right before the request after which the post may exist on the platform.
    on_commit: Callable[[], None] = lambda: None
    client: httpx.Client | None = None
    sleep: Callable[[float], None] = field(default=time.sleep)

    @property
    def size(self) -> int:
        return self.video_path.stat().st_size

    def http(self) -> httpx.Client:
        if self.client is None:
            self.client = httpx.Client(timeout=self.settings.publish_http_timeout_seconds, follow_redirects=True)
        return self.client


@dataclass(frozen=True)
class PublishResult:
    external_id: str
    url: str | None


class Publisher(Protocol):
    def publish(self, ctx: PublishContext) -> PublishResult: ...


def raise_for_response(res: httpx.Response, step: str, *, committed: bool = False) -> dict:
    """Map a platform HTTP error onto a PublishError with the platform's own message."""
    try:
        body = res.json()
    except ValueError:
        body = {}
    if res.is_success:
        return body if isinstance(body, dict) else {}
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        detail = err.get("error_user_msg") or err.get("message") or str(err)
    else:
        detail = str(err or res.text[:300])
    retryable = res.status_code >= 500 or res.status_code == 429
    raise PublishError(f"{step}_failed", f"{step} failed (HTTP {res.status_code}): {detail}", retryable=retryable, committed=committed)


def iter_file(path: Path, start: int = 0, end: int | None = None, chunk: int = 1024 * 1024, on_bytes=None):
    """Stream [start, end) of a file in chunks, reporting cumulative bytes."""
    with path.open("rb") as fh:
        fh.seek(start)
        remaining = (end if end is not None else path.stat().st_size) - start
        sent = 0
        while remaining > 0:
            data = fh.read(min(chunk, remaining))
            if not data:
                break
            remaining -= len(data)
            sent += len(data)
            if on_bytes:
                on_bytes(sent)
            yield data


class DryRunPublisher:
    """PUBLISH_DRY_RUN=true: exercise the whole flow without calling any platform."""

    def __init__(self, platform: str):
        self.platform = platform

    def publish(self, ctx: PublishContext) -> PublishResult:
        for i in range(1, 5):
            ctx.sleep(0.2)
            ctx.on_progress(i / 4)
            if i == 3:
                ctx.on_commit()
        fake = f"dryrun-{uuid.uuid4().hex[:10]}"
        return PublishResult(external_id=fake, url=f"https://example.invalid/{self.platform}/{fake}")


def get_publisher(platform: str, settings: Settings) -> Publisher:
    if settings.publish_dry_run:
        return DryRunPublisher(platform)
    if platform == "youtube":
        from .youtube import YoutubePublisher

        return YoutubePublisher()
    if platform == "facebook":
        from .facebook import FacebookReelsPublisher

        return FacebookReelsPublisher()
    if platform == "instagram":
        from .instagram import InstagramReelsPublisher

        return InstagramReelsPublisher()
    raise PublishError("unknown_platform", f"Unknown platform {platform!r}")
