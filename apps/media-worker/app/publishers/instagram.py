"""Instagram Reels via the Instagram Graph API (Facebook Login flavour).

container (resumable) -> binary upload -> poll until FINISHED -> media_publish.
Needs an Instagram Business/Creator account linked to a Facebook Page and a token
with instagram_basic + instagram_content_publish.
"""

from __future__ import annotations

import time

from .base import PublishContext, PublishError, PublishResult, iter_file, raise_for_response

POLL_TIMEOUT_SECONDS = 600


class InstagramReelsPublisher:
    def publish(self, ctx: PublishContext) -> PublishResult:
        ig_user = str(ctx.config.get("igUserId") or "")
        token = ctx.credentials.get("accessToken")
        if not (ig_user and token):
            raise PublishError("not_connected", "Instagram account ID or access token missing")
        version = str(ctx.config.get("graphVersion") or "v23.0")
        graph = f"https://graph.facebook.com/{version}"
        http = ctx.http()
        share = ctx.config.get("shareToFeed", True) not in (False, "false")

        container = raise_for_response(
            http.post(
                f"{graph}/{ig_user}/media",
                data={
                    "media_type": "REELS",
                    "upload_type": "resumable",
                    "caption": ctx.description[:2200],
                    "share_to_feed": "true" if share else "false",
                    "access_token": token,
                },
            ),
            "ig_container",
        )
        container_id = container.get("id")
        upload_uri = container.get("uri") or f"https://rupload.facebook.com/ig-api-upload/{version}/{container_id}"
        if not container_id:
            raise PublishError("ig_container_failed", f"No container id returned: {container}", retryable=True)

        size = ctx.size
        up = http.post(
            upload_uri,
            headers={
                "Authorization": f"OAuth {token}",
                "offset": "0",
                "file_size": str(size),
                "Content-Length": str(size),
            },
            content=iter_file(ctx.video_path, on_bytes=lambda n: ctx.on_progress(n / size * 0.7)),
        )
        raise_for_response(up, "ig_upload")

        deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
        while True:
            st = raise_for_response(
                http.get(f"{graph}/{container_id}", params={"fields": "status_code,status", "access_token": token}),
                "ig_status",
            )
            code = st.get("status_code")
            if code == "FINISHED":
                break
            if code in ("ERROR", "EXPIRED"):
                raise PublishError("ig_processing_failed", f"Instagram could not process the video: {st.get('status')}")
            if time.monotonic() > deadline:
                raise PublishError("ig_processing_timeout", "Instagram is still processing the video", retryable=True)
            ctx.sleep(5)
        ctx.on_progress(0.85)

        ctx.on_commit()  # media_publish makes the reel live
        published = raise_for_response(
            http.post(f"{graph}/{ig_user}/media_publish", data={"creation_id": container_id, "access_token": token}),
            "ig_publish",
            committed=True,
        )
        media_id = published.get("id")
        if not media_id:
            raise PublishError("ig_publish_failed", f"No media id returned: {published}", committed=True)

        url = None
        try:
            link = http.get(f"{graph}/{media_id}", params={"fields": "permalink", "access_token": token})
            if link.is_success:
                url = link.json().get("permalink")
        except Exception:
            pass  # permalink is cosmetic
        ctx.on_progress(1.0)
        return PublishResult(external_id=str(media_id), url=url)
