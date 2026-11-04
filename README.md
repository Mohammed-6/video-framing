# ClipForge

A personal automation tool that turns long YouTube videos into captioned vertical shorts and publishes them to **YouTube Shorts, Facebook Reels and Instagram Reels**.

```
Discover ──▶ select videos ──▶ [automatic] download → transcribe → pick highlights → 9:16 + captions → render
                                                                                                      │
                     Published ◀────────── publish now ◀───────── Review (approve, tweak text, skip) ◀────┘
```

You only touch two steps: **picking source videos** and **approving clips** in the review queue. Everything in between runs on its own. There's one login (your password), with no plans, quotas or admin area.

> **Rights:** The YouTube Data API can't download videos, so ClipForge uses `yt-dlp`, which is against YouTube's Terms of Service. Reposting other people's content without permission can infringe copyright. You are responsible for the videos you import. By default, captions credit the source video and channel (`{source_*}` placeholders), and search can filter to Creative Commons.

## How it works

| Step | What happens | Code |
| --- | --- | --- |
| Discover | YouTube Data API search (or pasted links). Already-imported videos are marked. | `apps/api/src/modules/youtube` |
| Import | One pipeline job per video; the worker downloads with yt-dlp (≤1080p MP4) into storage | `pipeline/download.py` |
| Analyze | ffprobe → audio → Whisper word timestamps → scene cuts → clip selection (LLM or heuristic), validated against duration, length and overlap rules | `consumers/analysis.py`, `pipeline/select_clips.py` |
| Auto-render | Every selected clip is rendered with your default caption style, so it lands in **Review** ready to watch | `consumers/render.py`, `pipeline/captions.py` |
| Speaker framing | The 9:16 window follows the active speaker (details below) | `pipeline/face_track.py` |
| Review | Watch the rendered short; edit title/caption per platform, re-trim in the editor, skip, or approve | `/review`, `/clips/[id]` |
| Publish | One job per clip × platform. Same clip can't go to the same platform twice. | `consumers/publish.py`, `publishers/*` |

**How publishing stays safe.**
- If an error happens before the platform has accepted the upload, the job retries automatically with backoff.
- If the worker stops mid-upload (crash, restart, computer turned off) *before* the final step, nothing reached the platform. The post is queued again and goes out when the worker is back.
- The final step is YouTube's last chunk, Facebook's `finish` or Instagram's `media_publish`. If anything fails at or after it, the job is marked failed with a "may already be live" note and isn't retried automatically, so a post is never duplicated. You can retry it from **Published** after checking the platform.

**How speaker framing works.**
- The worker samples each clip at 4 fps and finds faces with OpenCV's YuNet detector (CPU, a few seconds per clip).
- It follows each face across frames, and picks the speaker by mouth movement plus face size. A challenger has to clearly win for about 0.75 s before the camera switches, so short interjections don't cause jumps.
- The camera stays still for small movements, eases to follow larger ones, and hard-cuts on a speaker change or a scene cut. The path becomes a per-frame ffmpeg crop expression and is saved with the render, so the editor preview plays the same motion.
- **Several people on screen ("Show everyone", the default):** the window widens through four zoom levels, from tight 9:16 up to the whole scene with black bars above and below, picking the tightest level that fits every main face with some margin. Small background faces (under 45% of the largest) are ignored, so a crowd doesn't force a full zoom-out. Zoom changes are clean cuts. It zooms out slightly *before* someone enters, but only zooms back in after about 2 s of evidence, so people turning away or briefly lost faces don't cause blips. Choose "Follow the speaker" instead to always use a tight crop on whoever is talking.
- **Steady layout (default):** if any part of a clip needs the zoomed-out view, the whole clip uses it, so it never jumps between a tight crop and a zoomed-out, blurred frame. While only one person is on screen, the camera pans gently to them inside that frame. Pick "Show everyone, switch tight/wide" in Settings → Rendering, or in the editor, to get the switching behaviour back.
- Fallbacks: if no faces are found it uses the fixed position. Vertical sources aren't panned.
- Manual control: untick "Auto framing" in the editor to set a fixed **position** and **zoom out** (fill 9:16 → whole scene). Defaults live in Settings → Rendering.
- Under the hood each zoom level is an ffmpeg branch (crop → scale → pad to 1080×1920), and timed `overlay` gates cut between them frame-accurately. The plan is saved with the render, and the editor preview plays the same zoom and borders.
- **Zoomed-out bars:** filled with a blurred, slightly darkened copy of the same moving shot (default), or plain black. Set this in Settings → Rendering, or per render in the editor.
- Known limits: speaker choice is a heuristic, not audio-visual active-speaker detection. There's no split-screen layout for two people far apart.

**Brand kit (Settings → Brand kit).** Upload once, and it's applied to every render.

**Turning pieces on and off.** Intro, Outro, Music, Logo and Captions each have a checkbox in three places:
- **Settings → Brand kit → "Include in every short":** the default for new and automatic renders. Unticking keeps the file.
- **The clip editor:** for that clip's next render.
- **Each Review card:** change the ticks, then click **Re-render with changes**. The card comes back when the new render is ready. Publishing is disabled until then, so you never post the old version by mistake.

A piece that has no file set up is greyed out.

| Piece | How it's applied |
| --- | --- |
| Intro / outro video | Joined before and after the clip. Any size or aspect is fitted to 9:16 with black bars, and any frame rate is converted. Silent files get a silent track, so audio stays in sync. |
| Background music | Plays under the *whole* short (intro + clip + outro). It loops if short, fades in and out, and is ducked (lowered automatically) while someone talks. Volume is adjustable. Use royalty-free tracks: platforms mute or block copyrighted music. |
| Logo (PNG/WebP/JPEG) | Overlaid on the clip in a chosen corner with adjustable size and opacity. Transparency is kept. This is separate from the text watermark. |

With an intro or outro the render takes two passes: the clip is encoded near-lossless, then all parts are normalised and joined in one final encode. Without them it's a single pass. To try it: `scripts/make-test-brand-assets.sh` generates sample assets, and `scripts/brand-smoke.mjs` uploads them and renders a clip.

## Setup

### 1. Run it

```bash
cp .env.example .env    # fill in APP_PASSWORD, JWT_SECRET, CREDENTIALS_KEY (commands are in the file)
docker compose up --build
# open http://localhost:3000 (or WEB_PORT) and sign in with APP_PASSWORD
```

`CREDENTIALS_KEY` encrypts platform tokens in the database (AES-256-GCM). If you lose or change it, you'll need to reconnect every platform.

### 2. YouTube search: `YOUTUBE_API_KEY`

In Google Cloud Console, enable **YouTube Data API v3**, create an API key, and put it in `.env`. A search costs 100 units of the 10,000/day free quota, so about 100 searches a day. Without a key you can still paste links in Discover.

- **Usage meter.** Discover shows "≈ used / 10,000 units today" and roughly how many searches are left. It resets at midnight Pacific, as Google's quota does. It's the app's own count, stored in Postgres, so calls made with the same key elsewhere aren't included. When Google says the quota is gone, the meter shows "Used up" and search gives a clear error; pasted links keep working. If Google raises your quota, set `YOUTUBE_DAILY_QUOTA`.
- **Cache.** The same search (ignoring case and spacing, with the same filters and page) within `YOUTUBE_CACHE_TTL_SECONDS` (default 1 hour) is answered from memory for free. Video details are cached per video too. "Already imported" badges always come fresh from the database. The cache is cleared when the API restarts. Set the TTL to `0` to turn it off.

### 3. Connect platforms (Settings → Publishing platforms)

| Platform | What you need | Notes |
| --- | --- | --- |
| **YouTube Shorts** | OAuth client (type *Web application*) with the redirect URI shown in Settings → click **Connect Google account** | Unverified API projects can only upload **private** videos until Google's audit passes. Vertical ≤ 3 min = Short. |
| **Facebook Reels** | Page ID + long-lived **Page** access token (`pages_manage_posts`, `pages_read_engagement`, `pages_show_list`) | Posts to a Page, not a personal profile. |
| **Instagram Reels** | Business/Creator account ID + long-lived token (`instagram_basic`, `instagram_content_publish`) | The account must be linked to a Facebook Page. |

Use **Test connection** after saving. Each platform has its own caption template and hashtags. Placeholders: `{title} {hook} {hashtags} {source_title} {source_channel} {source_url}`.

### 4. Defaults (Settings → Pipeline defaults)

Defaults cover clips per video, min/max length, language, caption style, resolution, highlight colour, caption position, an optional watermark, and the auto-render switch.

### Troubleshooting

- **"YouTube blocked the download with a bot check"** usually happens from cloud IPs. Export your browser's youtube.com cookies (Netscape format) to `secrets/youtube-cookies.txt` and set `YTDLP_COOKIES_FILE=/secrets/youtube-cookies.txt`.
- **To try the whole flow without posting anything**, set `PUBLISH_DRY_RUN=true`. Publishing then returns fake post IDs.
- **For better clip picks**, set `CLIP_PLANNER=llm` plus `OPENAI_API_KEY` (or `AZURE_OPENAI_*`). If the LLM fails, the heuristic planner is used automatically.

## Tests

```bash
pnpm install && pnpm typecheck && pnpm test                     # API: templates, IDs, crypto, clip bounds
cd apps/media-worker && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt
.venv/Scripts/python -m pytest                                    # clip selection, captions, reframe, publishers (mocked HTTP)

# End-to-end against the running stack (worker must have PUBLISH_DRY_RUN=true):
APP_PASSWORD=... node scripts/smoke.mjs ./some-talk.mp4
APP_PASSWORD=... node scripts/smoke.mjs "https://www.youtube.com/watch?v=..."
```

## Layout

```
apps/web/            Next.js: discover, library, review, clip editor, published, settings
apps/api/            Express API (/api/v1): auth, youtube, videos, clips, renders, review, publications, platforms, settings
apps/media-worker/   Python: queue consumers (analysis, render, publish), pipeline/, publishers/
packages/contracts/  Shared zod schemas/types (+ caption template rendering)
infra/docker/        Dockerfiles      infra/gcp/terraform/  Cloud Run + Cloud SQL + GCS + Secret Manager + HTTPS LB
```

## Deploying to GCP

```bash
cd infra/gcp/terraform
cp terraform.tfvars.example terraform.tfvars        # project_id, region, domain, image_tag
terraform init && terraform apply -target=google_artifact_registry_repository.images
REG=$(terraform output -raw image_registry); TAG=$(date +%Y%m%d-%H%M)
for s in api web media-worker; do docker build -f ../../docker/$s.Dockerfile -t $REG/$s:$TAG ../../.. && docker push $REG/$s:$TAG; done
terraform apply -var image_tag=$TAG -var youtube_api_key=... -var google_oauth_client_id=... -var google_oauth_client_secret=...
gcloud secrets versions access latest --secret=clipforge-prod-app-password   # your login password (unless you set app_password)
```

Point DNS for `domain` at `terraform output lb_ip`. Web and API share one origin behind the load balancer, so the YouTube OAuth redirect URI is `https://<domain>/api/v1/platforms/youtube/oauth/callback`. Keep the worker at `min_instances >= 1` so queued jobs are picked up.
#   v i d e o - f r a m i n g  
 