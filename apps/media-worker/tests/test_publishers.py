from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.crypto import decrypt_credentials, encrypt_credentials
from app.errors import PipelineError
from app.pipeline.download import classify_error
from app.publishers.base import PublishContext, PublishError, get_publisher
from app.publishers.facebook import FacebookReelsPublisher
from app.publishers.instagram import InstagramReelsPublisher
from app.publishers.youtube import CHUNK, YoutubePublisher


@pytest.fixture
def video(tmp_path: Path) -> Path:
    p = tmp_path / "clip.mp4"
    p.write_bytes(os.urandom(CHUNK + 1234))  # forces two YouTube chunks
    return p


def ctx_for(video: Path, handler, config: dict, credentials: dict) -> tuple[PublishContext, list[float]]:
    progress: list[float] = []
    ctx = PublishContext(
        video_path=video,
        title="Why startups fail #Shorts",
        description="desc #shorts",
        config=config,
        credentials=credentials,
        settings=Settings(),
        on_progress=progress.append,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda _s: None,
    )
    return ctx, progress


# -- YouTube ------------------------------------------------------------------

def test_youtube_resumable_upload(video: Path):
    calls: list[tuple[str, str]] = []
    received = bytearray()
    size = video.stat().st_size

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append((req.method, req.url.host + req.url.path))
        if req.url.host == "oauth2.googleapis.com":
            assert b"grant_type=refresh_token" in req.content
            return httpx.Response(200, json={"access_token": "at"})
        if req.method == "POST":
            body = json.loads(req.content)
            assert body["snippet"]["title"] == "Why startups fail #Shorts"
            assert body["status"]["privacyStatus"] == "unlisted"
            assert req.headers["X-Upload-Content-Length"] == str(size)
            return httpx.Response(200, headers={"Location": "https://upload.example/session"})
        assert req.headers["Authorization"] == "Bearer at"
        received.extend(req.read())
        start, end = req.headers["Content-Range"].split(" ")[1].split("/")[0].split("-")
        if int(end) + 1 < size:
            return httpx.Response(308, headers={"Range": f"bytes=0-{end}"})
        return httpx.Response(200, json={"id": "vid123", "status": {"uploadStatus": "uploaded"}})

    ctx, progress = ctx_for(
        video, handler, {"privacyStatus": "unlisted"}, {"clientId": "c", "clientSecret": "s", "refreshToken": "r"}
    )
    result = YoutubePublisher().publish(ctx)
    assert result.external_id == "vid123"
    assert result.url == "https://www.youtube.com/shorts/vid123"
    assert bytes(received) == video.read_bytes()
    assert [m for m, _ in calls] == ["POST", "POST", "PUT", "PUT"]
    assert progress[-1] == 1.0


def test_youtube_revoked_token_is_not_retryable(video: Path):
    def handler(req):
        return httpx.Response(400, json={"error": "invalid_grant"})

    ctx, _ = ctx_for(video, handler, {}, {"clientId": "c", "clientSecret": "s", "refreshToken": "r"})
    with pytest.raises(PublishError) as e:
        YoutubePublisher().publish(ctx)
    assert e.value.code == "oauth_revoked" and not e.value.retryable


def test_youtube_server_error_is_retryable(video: Path):
    def handler(req):
        if req.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "at"})
        return httpx.Response(503, json={"error": {"message": "backend error"}})

    ctx, _ = ctx_for(video, handler, {}, {"clientId": "c", "clientSecret": "s", "refreshToken": "r"})
    with pytest.raises(PublishError) as e:
        YoutubePublisher().publish(ctx)
    assert e.value.retryable and "backend error" in e.value.message


# -- Facebook -----------------------------------------------------------------

def test_facebook_reel_flow(video: Path):
    steps: list[str] = []
    status_calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "rupload.facebook.com":
            steps.append("upload")
            assert req.headers["Authorization"] == "OAuth ptok"
            assert req.headers["file_size"] == str(video.stat().st_size)
            assert req.read() == video.read_bytes()
            return httpx.Response(200, json={"success": True})
        if req.method == "POST":
            form = dict(x.split("=", 1) for x in req.content.decode().split("&"))
            steps.append(form["upload_phase"])
            assert req.url.path == "/v23.0/PAGE1/video_reels"
            if form["upload_phase"] == "start":
                return httpx.Response(200, json={"video_id": "V9", "upload_url": "https://rupload.facebook.com/video-upload/v23.0/V9"})
            assert form["video_state"] == "PUBLISHED"
            return httpx.Response(200, json={"success": True})
        steps.append("status")
        status_calls["n"] += 1
        phase = "complete" if status_calls["n"] > 1 else "in_progress"
        return httpx.Response(200, json={"status": {"video_status": "processing", "publishing_phase": {"status": phase}}})

    ctx, progress = ctx_for(video, handler, {"pageId": "PAGE1"}, {"pageAccessToken": "ptok"})
    result = FacebookReelsPublisher().publish(ctx)
    assert result.external_id == "V9" and result.url == "https://www.facebook.com/reel/V9"
    assert steps == ["start", "upload", "finish", "status", "status"]
    assert progress[-1] == 1.0


def test_facebook_error_after_finish_is_committed(video: Path):
    def handler(req):
        if req.url.host == "rupload.facebook.com":
            return httpx.Response(200, json={"success": True})
        if req.method == "POST":
            return httpx.Response(200, json={"video_id": "V9", "success": True})
        return httpx.Response(200, json={"status": {"video_status": "error", "processing_phase": {"status": "error"}}})

    ctx, _ = ctx_for(video, handler, {"pageId": "P"}, {"pageAccessToken": "t"})
    with pytest.raises(PublishError) as e:
        FacebookReelsPublisher().publish(ctx)
    assert e.value.committed and not e.value.retryable and "may already be live" in e.value.message


# -- Instagram ----------------------------------------------------------------

def test_instagram_reel_flow(video: Path):
    steps: list[str] = []
    polls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if req.url.host == "rupload.facebook.com":
            steps.append("upload")
            assert req.read() == video.read_bytes()
            return httpx.Response(200, json={"success": True})
        if path.endswith("/IG1/media"):
            steps.append("container")
            form = req.content.decode()
            assert "media_type=REELS" in form and "upload_type=resumable" in form
            return httpx.Response(200, json={"id": "C1", "uri": "https://rupload.facebook.com/ig-api-upload/v23.0/C1"})
        if path.endswith("/C1"):
            steps.append("status")
            polls["n"] += 1
            return httpx.Response(200, json={"status_code": "FINISHED" if polls["n"] > 1 else "IN_PROGRESS"})
        if path.endswith("/media_publish"):
            steps.append("publish")
            return httpx.Response(200, json={"id": "M1"})
        if path.endswith("/M1"):
            return httpx.Response(200, json={"permalink": "https://www.instagram.com/reel/abc/"})
        raise AssertionError(f"unexpected {req.method} {req.url}")

    ctx, _ = ctx_for(video, handler, {"igUserId": "IG1"}, {"accessToken": "tok"})
    result = InstagramReelsPublisher().publish(ctx)
    assert result.external_id == "M1" and result.url == "https://www.instagram.com/reel/abc/"
    assert steps == ["container", "upload", "status", "status", "publish"]


def test_instagram_processing_error(video: Path):
    def handler(req):
        if req.url.host == "rupload.facebook.com":
            return httpx.Response(200, json={"success": True})
        if req.url.path.endswith("/media"):
            return httpx.Response(200, json={"id": "C1"})
        return httpx.Response(200, json={"status_code": "ERROR", "status": "Error: unsupported aspect ratio"})

    ctx, _ = ctx_for(video, handler, {"igUserId": "IG1"}, {"accessToken": "tok"})
    with pytest.raises(PublishError) as e:
        InstagramReelsPublisher().publish(ctx)
    assert e.value.code == "ig_processing_failed" and "aspect ratio" in e.value.message


def test_meta_graph_error_message_surfaces(video: Path):
    def handler(req):
        return httpx.Response(400, json={"error": {"message": "Invalid OAuth access token", "code": 190}})

    ctx, _ = ctx_for(video, handler, {"igUserId": "IG1"}, {"accessToken": "bad"})
    with pytest.raises(PublishError) as e:
        InstagramReelsPublisher().publish(ctx)
    assert "Invalid OAuth access token" in e.value.message and not e.value.retryable


def test_dry_run_publisher(video: Path):
    ctx, progress = ctx_for(video, lambda r: httpx.Response(500), {}, {})
    result = get_publisher("youtube", Settings(publish_dry_run=True)).publish(ctx)
    assert result.external_id.startswith("dryrun-") and progress[-1] == 1.0


# -- crypto & download errors -------------------------------------------------

def test_credentials_roundtrip_and_wrong_key():
    key = base64.b64encode(os.urandom(32)).decode()
    enc = encrypt_credentials({"accessToken": "secret"}, key)
    assert decrypt_credentials(enc, key) == {"accessToken": "secret"}
    with pytest.raises(PipelineError):
        decrypt_credentials(enc, base64.b64encode(os.urandom(32)).decode())


def test_decrypts_node_ciphertext():
    """Fixture produced by apps/api CredentialCipher (Node) — guards format compatibility."""
    key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
    node_ct = os.environ.get("NODE_CIPHERTEXT")
    if not node_ct:
        pytest.skip("set NODE_CIPHERTEXT to run the cross-language check")
    assert decrypt_credentials(node_ct, key) == {"token": "from-node"}


@pytest.mark.parametrize(
    "msg,code,retryable",
    [
        ("ERROR: [youtube] x: Sign in to confirm you’re not a bot", "youtube_bot_check", False),
        ("ERROR: [youtube] x: Private video. Sign in if you've been granted access", "video_unavailable", False),
        ("ERROR: [youtube] x: Video unavailable", "video_unavailable", False),
        ("ERROR: unable to download video data: HTTP Error 503", "download_failed", True),
    ],
)
def test_classify_download_errors(msg, code, retryable):
    err = classify_error(msg)
    assert (err.code, err.retryable) == (code, retryable)


# -- commit points (safe re-queue after a crash) -------------------------------
# Each publisher must call ctx.on_commit() right before the request that can make the post
# exist on the platform, and not earlier: a worker that dies before it is safely re-queued.

def _with_commit_log(ctx: PublishContext, log: list[str]) -> PublishContext:
    ctx.on_commit = lambda: log.append("COMMIT")
    return ctx


def test_youtube_commits_only_before_final_chunk(video: Path):
    log: list[str] = []
    size = video.stat().st_size

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "at"})
        if req.method == "POST":
            return httpx.Response(200, headers={"Location": "https://upload.example/session"})
        end = int(req.headers["Content-Range"].split(" ")[1].split("/")[0].split("-")[1])
        log.append("final" if end + 1 == size else "chunk")
        if end + 1 < size:
            return httpx.Response(308, headers={"Range": f"bytes=0-{end}"})
        return httpx.Response(200, json={"id": "v1"})

    ctx, _ = ctx_for(video, handler, {}, {"clientId": "c", "clientSecret": "s", "refreshToken": "r"})
    YoutubePublisher().publish(_with_commit_log(ctx, log))
    assert log == ["chunk", "COMMIT", "final"]


def test_youtube_failure_before_commit_does_not_commit(video: Path):
    log: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "at"})
        if req.method == "POST":
            return httpx.Response(200, headers={"Location": "https://upload.example/session"})
        return httpx.Response(503, json={"error": {"message": "backend"}})

    ctx, _ = ctx_for(video, handler, {}, {"clientId": "c", "clientSecret": "s", "refreshToken": "r"})
    with pytest.raises(PublishError):
        YoutubePublisher().publish(_with_commit_log(ctx, log))
    assert "COMMIT" not in log


def test_facebook_commits_right_before_finish(video: Path):
    log: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "rupload.facebook.com":
            log.append("upload")
            return httpx.Response(200, json={"success": True})
        if req.method == "POST":
            phase = dict(x.split("=", 1) for x in req.content.decode().split("&"))["upload_phase"]
            log.append(phase)
            if phase == "start":
                return httpx.Response(200, json={"video_id": "V9", "upload_url": "https://rupload.facebook.com/x/V9"})
            return httpx.Response(200, json={"success": True})
        return httpx.Response(200, json={"status": {"video_status": "ready", "publishing_phase": {"status": "complete"}}})

    ctx, _ = ctx_for(video, handler, {"pageId": "P"}, {"pageAccessToken": "t"})
    FacebookReelsPublisher().publish(_with_commit_log(ctx, log))
    assert log[:4] == ["start", "upload", "COMMIT", "finish"]


def test_instagram_commits_right_before_media_publish(video: Path):
    log: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if req.url.host == "rupload.facebook.com":
            log.append("upload")
            return httpx.Response(200, json={"success": True})
        if path.endswith("/IG1/media"):
            log.append("container")
            return httpx.Response(200, json={"id": "C1", "uri": "https://rupload.facebook.com/x/C1"})
        if path.endswith("/C1"):
            log.append("status")
            return httpx.Response(200, json={"status_code": "FINISHED"})
        if path.endswith("/media_publish"):
            log.append("publish")
            return httpx.Response(200, json={"id": "M1"})
        return httpx.Response(200, json={"permalink": "https://www.instagram.com/reel/x/"})

    ctx, _ = ctx_for(video, handler, {"igUserId": "IG1"}, {"accessToken": "tok"})
    InstagramReelsPublisher().publish(_with_commit_log(ctx, log))
    assert log == ["container", "upload", "status", "COMMIT", "publish"]
