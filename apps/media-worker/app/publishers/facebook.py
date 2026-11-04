"""Facebook Reels for a Page via the Graph API video_reels endpoint.

start -> binary upload to rupload.facebook.com -> finish (publish) -> poll status.
Needs a Page access token with pages_manage_posts / pages_read_engagement / pages_show_list.
"""

from __future__ import annotations

import time

from .base import PublishContext, PublishError, PublishResult, iter_file, raise_for_response

POLL_TIMEOUT_SECONDS = 600


class FacebookReelsPublisher:
    def publish(self, ctx: PublishContext) -> PublishResult:
        page_id = str(ctx.config.get("pageId") or "")
        token = ctx.credentials.get("pageAccessToken")
        if not (page_id and token):
            raise PublishError("not_connected", "Facebook Page ID or Page access token missing")
        version = str(ctx.config.get("graphVersion") or "v23.0")
        graph = f"https://graph.facebook.com/{version}"
        http = ctx.http()

        start = raise_for_response(
            http.post(f"{graph}/{page_id}/video_reels", data={"upload_phase": "start", "access_token": token}),
            "reel_start",
        )
        video_id = start.get("video_id")
        upload_url = start.get("upload_url") or f"https://rupload.facebook.com/video-upload/{version}/{video_id}"
        if not video_id:
            raise PublishError("reel_start_failed", f"No video id returned: {start}", retryable=True)

        size = ctx.size
        up = http.post(
            upload_url,
            headers={
                "Authorization": f"OAuth {token}",
                "offset": "0",
                "file_size": str(size),
                "Content-Length": str(size),
            },
            content=iter_file(ctx.video_path, on_bytes=lambda n: ctx.on_progress(n / size * 0.8)),
        )
        if not raise_for_response(up, "reel_upload").get("success", True):
            raise PublishError("reel_upload_failed", "Upload was not accepted", retryable=True)

        ctx.on_commit()  # 'finish' publishes the reel
        finish = http.post(
            f"{graph}/{page_id}/video_reels",
            data={
                "access_token": token,
                "video_id": video_id,
                "upload_phase": "finish",
                "video_state": "PUBLISHED",
                "description": ctx.description,
                "title": ctx.title,
            },
        )
        raise_for_response(finish, "reel_publish", committed=finish.status_code >= 500)
        ctx.on_progress(0.9)

        # From here on the reel exists; any failure is "committed".
        deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            st = http.get(f"{graph}/{video_id}", params={"fields": "status", "access_token": token})
            status = raise_for_response(st, "reel_status", committed=True).get("status") or {}
            video_status = status.get("video_status")
            phase = (status.get("publishing_phase") or {}).get("status")
            processing = status.get("processing_phase") or {}
            if video_status == "error" or processing.get("status") == "error":
                errs = processing.get("errors") or status
                raise PublishError("reel_processing_failed", f"Facebook rejected the video: {errs}", committed=True)
            if phase == "complete" or video_status in ("ready", "published"):
                ctx.on_progress(1.0)
                return PublishResult(external_id=str(video_id), url=f"https://www.facebook.com/reel/{video_id}")
            ctx.sleep(5)
        # Still processing: Facebook will finish publishing on its own.
        return PublishResult(external_id=str(video_id), url=f"https://www.facebook.com/reel/{video_id}")
