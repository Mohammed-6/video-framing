/**
 * YouTube Data API quota bookkeeping and a small response cache.
 *
 * Google enforces the real quota per API key; this is the app's own estimate of what it spent,
 * kept in Postgres so restarts don't reset it. Calls from other apps using the same key are not
 * seen here, so the number can only under-count.
 */
import type { YoutubeQuota } from "@clipforge/contracts";
import type { Db } from "../../db/pool";

/** Unit cost per endpoint (https://developers.google.com/youtube/v3/determine_quota_cost). */
export const QUOTA_COST = { search: 100, videos: 1 } as const;
export type QuotaEndpoint = keyof typeof QUOTA_COST;

const PACIFIC_DAY = "(now() AT TIME ZONE 'America/Los_Angeles')::date";
const NEXT_RESET =
  "((date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') + interval '1 day') AT TIME ZONE 'America/Los_Angeles')";

export class QuotaTracker {
  constructor(
    private readonly db: Pick<Db, "query" | "one">,
    readonly dailyLimit: number,
  ) {}

  async spend(endpoint: QuotaEndpoint): Promise<void> {
    await this.db.query(
      `INSERT INTO youtube_quota_usage (day, units) VALUES (${PACIFIC_DAY}, $1)
       ON CONFLICT (day) DO UPDATE SET units = youtube_quota_usage.units + EXCLUDED.units, updated_at = now()`,
      [QUOTA_COST[endpoint]],
    );
  }

  /** Google said the quota is gone: show it as used up until the reset. */
  async markExhausted(): Promise<void> {
    await this.db.query(
      `INSERT INTO youtube_quota_usage (day, units, exhausted_at) VALUES (${PACIFIC_DAY}, $1, now())
       ON CONFLICT (day) DO UPDATE SET units = GREATEST(youtube_quota_usage.units, EXCLUDED.units),
                                       exhausted_at = now(), updated_at = now()`,
      [this.dailyLimit],
    );
  }

  async status(): Promise<YoutubeQuota> {
    const row = await this.db.one<{ units: number | null; exhausted: boolean | null; resets_at: Date }>(
      `SELECT u.units, u.exhausted_at IS NOT NULL AS exhausted, ${NEXT_RESET} AS resets_at
         FROM (SELECT 1) one
         LEFT JOIN youtube_quota_usage u ON u.day = ${PACIFIC_DAY}`,
    );
    const used = Math.min(row?.units ?? 0, this.dailyLimit);
    return {
      usedUnits: used,
      dailyLimit: this.dailyLimit,
      searchesLeft: Math.max(0, Math.floor((this.dailyLimit - used) / (QUOTA_COST.search + QUOTA_COST.videos))),
      exhausted: Boolean(row?.exhausted) || used >= this.dailyLimit,
      resetsAt: new Date(row?.resets_at ?? Date.now()).toISOString(),
    };
  }
}

/** Tiny in-memory TTL cache (insertion-ordered, oldest evicted first). */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value as string);
  }
}
