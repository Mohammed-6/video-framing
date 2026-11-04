/** Minimal YouTube Data API v3 client (search + video metadata). Costs: search = 100 units, videos = 1 unit. */
import type { YoutubeSearchQuery } from "@clipforge/contracts";
import { HttpError } from "../../http/errors";
import { TtlCache, type QuotaEndpoint } from "./quota";

const BASE = "https://www.googleapis.com/youtube/v3";

export type YoutubeMeta = {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  license: string;
  liveBroadcastContent: string;
};

/** ISO-8601 duration (PT1H2M3S, P1DT2H) -> seconds. */
export function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

function bestThumbnail(thumbs: any): string | null {
  for (const k of ["maxres", "standard", "high", "medium", "default"]) {
    if (thumbs?.[k]?.url) return thumbs[k].url;
  }
  return null;
}

export type SearchResult = { ids: string[]; nextPageToken: string | null; totalResults: number };

export type YoutubeClientOptions = {
  /** Called once per request Google accepted (and billed). */
  onSpend?: (endpoint: QuotaEndpoint) => Promise<void> | void;
  /** Called when Google reports the daily quota is used up. */
  onExhausted?: () => Promise<void> | void;
  /** How long search results and video details are reused (default 1 h; 0 disables). */
  cacheTtlMs?: number;
};

/** Same search typed twice (any case/spacing) should hit the cache. */
export function searchCacheKey(q: YoutubeSearchQuery): string {
  return JSON.stringify([
    q.q.trim().toLowerCase().replace(/\s+/g, " "),
    q.order,
    q.videoDuration,
    q.videoLicense,
    q.publishedAfter ?? "",
    q.channelId ?? "",
    q.pageToken ?? "",
  ]);
}

export class YoutubeClient {
  private readonly searchCache: TtlCache<SearchResult>;
  private readonly metaCache: TtlCache<YoutubeMeta>;
  private readonly cacheEnabled: boolean;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch,
    private readonly opts: YoutubeClientOptions = {},
  ) {
    const ttl = opts.cacheTtlMs ?? 60 * 60 * 1000;
    this.cacheEnabled = ttl > 0;
    this.searchCache = new TtlCache(ttl, 300);
    this.metaCache = new TtlCache(ttl, 5000);
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  private async get(path: QuotaEndpoint, params: Record<string, string | undefined>) {
    if (!this.apiKey) {
      throw new HttpError(503, "youtube_not_configured", "Set YOUTUBE_API_KEY to enable YouTube search");
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, v);
    qs.set("key", this.apiKey);
    const res = await this.fetchImpl(`${BASE}/${path}?${qs}`);
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status;
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
        await this.track(() => this.opts.onExhausted?.());
        throw new HttpError(
          429,
          "youtube_quota_exceeded",
          "Today's YouTube search quota is used up. It resets at midnight Pacific time; pasting video links still works.",
          { reason },
        );
      }
      // Google bills rejected requests too (bad params etc.), except auth/quota failures.
      if (res.status === 400) await this.track(() => this.opts.onSpend?.(path));
      const message = body?.error?.message ?? `YouTube API error ${res.status}`;
      throw new HttpError(502, "youtube_api_error", message, { reason });
    }
    await this.track(() => this.opts.onSpend?.(path));
    return body;
  }

  /** Bookkeeping must never break the request itself. */
  private async track(fn: () => unknown) {
    try {
      await fn();
    } catch (err) {
      console.warn("youtube quota tracking failed", err);
    }
  }

  /** Search; `cached` is true when served from memory (costs no quota). */
  async search(q: YoutubeSearchQuery): Promise<SearchResult & { cached: boolean }> {
    const key = searchCacheKey(q);
    const hit = this.cacheEnabled ? this.searchCache.get(key) : undefined;
    if (hit) return { ...hit, cached: true };
    const body = await this.get("search", {
      part: "snippet",
      type: "video",
      maxResults: "24",
      q: q.q,
      order: q.order,
      videoDuration: q.videoDuration,
      videoLicense: q.videoLicense,
      publishedAfter: q.publishedAfter,
      channelId: q.channelId,
      pageToken: q.pageToken,
      safeSearch: "none",
    });
    const result: SearchResult = {
      ids: (body.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean),
      nextPageToken: body.nextPageToken ?? null,
      totalResults: body.pageInfo?.totalResults ?? 0,
    };
    if (this.cacheEnabled) this.searchCache.set(key, result);
    return { ...result, cached: false };
  }

  /** Metadata for up to 50 IDs, in the order given (missing/private videos are omitted). */
  async videos(ids: string[]): Promise<YoutubeMeta[]> {
    ids = ids.slice(0, 50);
    if (!ids.length) return [];
    const byId = new Map<string, YoutubeMeta>();
    for (const id of ids) {
      const hit = this.cacheEnabled ? this.metaCache.get(id) : undefined;
      if (hit) byId.set(id, hit);
    }
    const missing = ids.filter((id) => !byId.has(id));
    if (!missing.length) return ids.map((id) => byId.get(id)!);
    const body = await this.get("videos", { part: "snippet,contentDetails,statistics,status", id: missing.join(","), maxResults: "50" });
    for (const v of body.items ?? []) {
      byId.set(v.id, {
        videoId: v.id,
        title: v.snippet?.title ?? v.id,
        description: v.snippet?.description ?? "",
        channelId: v.snippet?.channelId ?? "",
        channelTitle: v.snippet?.channelTitle ?? "",
        publishedAt: v.snippet?.publishedAt ?? "",
        thumbnailUrl: bestThumbnail(v.snippet?.thumbnails),
        durationSeconds: parseIsoDuration(v.contentDetails?.duration),
        viewCount: v.statistics?.viewCount != null ? Number(v.statistics.viewCount) : null,
        license: v.status?.license ?? "youtube",
        liveBroadcastContent: v.snippet?.liveBroadcastContent ?? "none",
      });
      if (this.cacheEnabled) this.metaCache.set(v.id, byId.get(v.id)!);
    }
    return ids.map((id) => byId.get(id)).filter((v): v is YoutubeMeta => Boolean(v));
  }
}
