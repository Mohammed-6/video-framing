import { Router } from "express";
import { LIMITS } from "@clipforge/config";
import {
  AnalysisDefaults,
  ImportYoutubeRequest,
  YoutubeSearchQuery,
  parseYoutubeId,
  type ImportYoutubeResponse,
  type YoutubeSearchResponse,
  type YoutubeVideo,
} from "@clipforge/contracts";
import type { AppDeps } from "../../deps";
import { HttpError, parseBody } from "../../http/errors";
import { enqueueAnalysis } from "../../queue";
import { getSettings } from "../settings/service";
import { YoutubeClient, type YoutubeMeta } from "./client";
import { QuotaTracker } from "./quota";

export function youtubeRouter(deps: AppDeps): Router {
  const { cfg, db } = deps;
  const quota = new QuotaTracker(db, cfg.YOUTUBE_DAILY_QUOTA);
  const yt = new YoutubeClient(cfg.YOUTUBE_API_KEY, deps.fetch, {
    onSpend: (endpoint) => quota.spend(endpoint),
    onExhausted: () => quota.markExhausted(),
    cacheTtlMs: cfg.YOUTUBE_CACHE_TTL_SECONDS * 1000,
  });
  const router = Router();

  async function importedMap(ids: string[]) {
    if (!ids.length) return new Map<string, { id: string; status: string }>();
    const rows = await db.query<{ id: string; status: string; youtube_video_id: string }>(
      "SELECT id, status, youtube_video_id FROM source_videos WHERE youtube_video_id = ANY($1)",
      [ids],
    );
    return new Map(rows.map((r) => [r.youtube_video_id, { id: r.id, status: r.status }]));
  }

  function toVideo(m: YoutubeMeta, imported: Map<string, { id: string; status: string }>): YoutubeVideo {
    const imp = imported.get(m.videoId);
    return {
      videoId: m.videoId,
      url: `https://www.youtube.com/watch?v=${m.videoId}`,
      title: m.title,
      description: m.description.slice(0, 300),
      channelId: m.channelId,
      channelTitle: m.channelTitle,
      publishedAt: m.publishedAt,
      thumbnailUrl: m.thumbnailUrl,
      durationSeconds: m.durationSeconds,
      viewCount: m.viewCount,
      license: m.license,
      imported: imp ? { sourceVideoId: imp.id, status: imp.status as any } : null,
    };
  }

  /** Today's estimated quota use (this app only). */
  router.get("/quota", async (_req, res) => {
    res.json(await quota.status());
  });

  router.get("/search", async (req, res) => {
    const q = parseBody(YoutubeSearchQuery, req.query);
    const found = await yt.search(q);
    const [meta, imported] = await Promise.all([yt.videos(found.ids), importedMap(found.ids)]);
    const body: YoutubeSearchResponse = {
      items: meta.map((m) => toVideo(m, imported)),
      nextPageToken: found.nextPageToken,
      totalResults: found.totalResults,
      cached: found.cached,
      quota: await quota.status(),
    };
    res.json(body);
  });

  /** Lookup by URL/ID list (works for pasted links). */
  router.get("/videos", async (req, res) => {
    const raw = String(req.query.ids ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    const ids = [...new Set(raw.map(parseYoutubeId).filter((v): v is string => Boolean(v)))].slice(0, 50);
    const [meta, imported] = await Promise.all([yt.videos(ids), importedMap(ids)]);
    res.json({ items: meta.map((m) => toVideo(m, imported)) });
  });

  /**
   * Import selected videos: one source_video + one queued pipeline job each.
   * The worker downloads (yt-dlp), transcribes, selects clips and auto-renders them.
   */
  router.post("/import", async (req, res) => {
    const body = parseBody(ImportYoutubeRequest, req.body);
    const settings = await getSettings(db);
    const merged = { ...settings.analysis, ...body.analysis };
    const params = AnalysisDefaults.safeParse(merged);
    if (!params.success) throw new HttpError(400, "validation_error", "Invalid analysis options", params.error.flatten());

    const result: ImportYoutubeResponse = { queued: [], skipped: [] };
    const idByInput = new Map<string, string>();
    for (const input of body.videos) {
      const id = parseYoutubeId(input);
      if (!id) result.skipped.push({ input, reason: "Not a YouTube video ID or URL" });
      else if ([...idByInput.values()].includes(id)) continue;
      else idByInput.set(input, id);
    }
    const ids = [...idByInput.values()];
    // Metadata is best-effort: without an API key the worker fills it in from yt-dlp.
    const meta = yt.enabled ? new Map((await yt.videos(ids)).map((m) => [m.videoId, m])) : new Map<string, YoutubeMeta>();
    const already = await importedMap(ids);

    for (const [input, id] of idByInput) {
      if (already.has(id)) {
        result.skipped.push({ input, reason: "Already imported — re-run analysis from the library" });
        continue;
      }
      const m = meta.get(id);
      if (yt.enabled && !m) {
        result.skipped.push({ input, reason: "Video not found, private, or unavailable" });
        continue;
      }
      if (m && m.liveBroadcastContent !== "none") {
        result.skipped.push({ input, reason: "Live or upcoming streams can't be imported yet" });
        continue;
      }
      if (m?.durationSeconds && m.durationSeconds > LIMITS.maxSourceMinutes * 60) {
        result.skipped.push({ input, reason: `Longer than ${LIMITS.maxSourceMinutes} minutes` });
        continue;
      }
      const queued = await db.tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO source_videos (origin, youtube_video_id, source_url, title, channel_title, channel_id, license,
                                      thumbnail_url, duration_seconds, status)
           VALUES ('youtube', $1, $2, $3, $4, $5, $6, $7, $8, 'processing')
           ON CONFLICT (youtube_video_id) DO NOTHING
           RETURNING id`,
          [
            id,
            `https://www.youtube.com/watch?v=${id}`,
            m?.title ?? `YouTube video ${id}`,
            m?.channelTitle ?? null,
            m?.channelId ?? null,
            m?.license ?? null,
            m?.thumbnailUrl ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            m?.durationSeconds ?? null,
          ],
        );
        if (!rows[0]) return null; // raced with a concurrent import
        const job = await enqueueAnalysis(client, rows[0].id, params.data);
        return { videoId: id, sourceVideoId: rows[0].id as string, jobId: job.id as string };
      });
      if (queued) result.queued.push(queued);
      else result.skipped.push({ input, reason: "Already imported" });
    }
    res.status(result.queued.length ? 202 : 200).json(result);
  });

  return router;
}
