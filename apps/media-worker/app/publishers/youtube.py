"""YouTube Shorts via the Data API v3 resumable upload protocol.

A vertical video <= 3 minutes is classified as a Short automatically. Videos uploaded
by API projects that haven't passed Google's audit are locked to private.
"""

from __future__ import annotations

import httpx

from .base import PublishContext, PublishError, PublishResult, iter_file, raise_for_response

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
CHUNK = 8 * 1024 * 1024  # must be a multiple of 256 KiB


class YoutubePublisher:
    def access_token(self, ctx: PublishContext) -> str:
        c = ctx.credentials
        client_id = c.get("clientId") or ctx.settings.google_oauth_client_id
        client_secret = c.get("clientSecret") or ctx.settings.google_oauth_client_secret
        if not (client_id and client_secret and c.get("refreshToken")):
            raise PublishError("not_connected", "YouTube is not connected (missing OAuth client or refresh token)")
        res = ctx.http().post(
            TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": c["refreshToken"],
                "grant_type": "refresh_token",
            },
        )
        if res.status_code == 400:
            raise PublishError("oauth_revoked", "YouTube authorization was revoked or expired — reconnect in Settings")
        return raise_for_response(res, "token_refresh")["access_token"]

    def publish(self, ctx: PublishContext) -> PublishResult:
        token = self.access_token(ctx)
        cfg = ctx.config
        size = ctx.size
        metadata = {
            "snippet": {
                "title": ctx.title[:100],
                "description": ctx.description[:5000],
                "categoryId": str(cfg.get("categoryId") or "22"),
            },
            "status": {
                "privacyStatus": cfg.get("privacyStatus") or "public",
                "selfDeclaredMadeForKids": False,
            },
        }
        notify = "true" if cfg.get("notifySubscribers", True) not in (False, "false") else "false"
        init = ctx.http().post(
            UPLOAD_URL,
            params={"uploadType": "resumable", "part": "snippet,status", "notifySubscribers": notify},
            headers={
                "Authorization": f"Bearer {token}",
                "X-Upload-Content-Type": "video/mp4",
                "X-Upload-Content-Length": str(size),
            },
            json=metadata,
        )
        body = raise_for_response(init, "upload_init")
        session = init.headers.get("location")
        if not session:
            raise PublishError("upload_init_failed", f"No upload session returned: {body}", retryable=True)

        offset = 0
        while offset < size:
            end = min(offset + CHUNK, size)
            if end == size:
                ctx.on_commit()  # the final chunk creates the video
            try:
                res = ctx.http().put(
                    session,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "video/mp4",
                        "Content-Length": str(end - offset),
                        "Content-Range": f"bytes {offset}-{end - 1}/{size}",
                    },
                    content=iter_file(ctx.video_path, offset, end),
                )
            except httpx.TransportError as exc:
                raise PublishError("upload_failed", f"Network error during upload: {exc}", retryable=True) from exc
            if res.status_code == 308:  # Resume Incomplete
                rng = res.headers.get("range")  # "bytes=0-1234"
                offset = int(rng.split("-")[-1]) + 1 if rng else end
                ctx.on_progress(offset / size * 0.95)
                continue
            data = raise_for_response(res, "upload")
            video_id = data.get("id")
            if not video_id:
                raise PublishError("upload_failed", f"Upload finished without a video id: {data}", committed=True)
            ctx.on_progress(1.0)
            return PublishResult(external_id=video_id, url=f"https://www.youtube.com/shorts/{video_id}")
        raise PublishError("upload_failed", "Upload ended without a final response", retryable=True)
