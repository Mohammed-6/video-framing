"use client";

import type { ImportYoutubeResponse, YoutubeQuota, YoutubeSearchQuery, YoutubeVideo } from "@clipforge/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api, errorMessage } from "@/lib/api";
import { formatCount, formatDate, formatTime } from "@/lib/format";
import { useSession } from "@/lib/session";

type Filters = Pick<YoutubeSearchQuery, "order" | "videoDuration" | "videoLicense"> & { publishedWithin: string };

const WITHIN: Record<string, number | null> = { any: null, week: 7, month: 30, year: 365 };

/** Start of the UTC day `days` ago: stable all day, so repeated searches hit the cache. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function QuotaMeter({ quota, cached }: { quota: YoutubeQuota | null; cached: boolean }) {
  if (!quota) return null;
  const pct = Math.min(100, (quota.usedUnits / quota.dailyLimit) * 100);
  const resets = new Date(quota.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const bar = quota.exhausted || pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-brand-500";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500" title="Estimated from this app's own requests. Other apps using the same API key aren't counted.">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums">
        ≈ {quota.usedUnits.toLocaleString()} / {quota.dailyLimit.toLocaleString()} quota units today
      </span>
      <span>
        {quota.exhausted ? "Used up" : `~${quota.searchesLeft} searches left`} · resets {resets}
      </span>
      {cached && <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-emerald-300">from cache, no quota used</span>}
    </div>
  );
}

function Discover() {
  const { youtubeSearchEnabled } = useSession();
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filters>({ order: "relevance", videoDuration: "long", videoLicense: "any", publishedWithin: "any" });
  const [results, setResults] = useState<YoutubeVideo[]>([]);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, YoutubeVideo>>(new Map());
  const [links, setLinks] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clipCount, setClipCount] = useState<number | "">("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportYoutubeResponse | null>(null);
  const [quota, setQuota] = useState<YoutubeQuota | null>(null);
  const [cached, setCached] = useState(false);

  const refreshQuota = () => api.youtubeQuota().then(setQuota, () => undefined);
  useEffect(() => {
    if (youtubeSearchEnabled) refreshQuota();
  }, [youtubeSearchEnabled]);

  async function search(pageToken?: string) {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const days = WITHIN[filters.publishedWithin];
      const res = await api.searchYoutube({
        q,
        order: filters.order,
        videoDuration: filters.videoDuration,
        videoLicense: filters.videoLicense,
        pageToken,
        publishedAfter: days ? daysAgo(days) : undefined,
      });
      setResults((prev) => (pageToken ? [...prev, ...res.items] : res.items));
      setNextPage(res.nextPageToken);
      setQuota(res.quota);
      setCached(res.cached);
    } catch (e) {
      setError(errorMessage(e));
      setCached(false);
      refreshQuota();
    } finally {
      setLoading(false);
    }
  }

  function toggle(v: YoutubeVideo) {
    if (v.imported) return;
    setSelected((s) => {
      const n = new Map(s);
      if (n.has(v.videoId)) n.delete(v.videoId);
      else n.set(v.videoId, v);
      return n;
    });
  }

  const pastedLinks = links.split(/[\s,]+/).filter(Boolean);
  const total = selected.size + pastedLinks.length;

  async function startImport() {
    setImporting(true);
    setError(null);
    try {
      const res = await api.importYoutube({
        videos: [...selected.keys(), ...pastedLinks],
        ...(clipCount ? { analysis: { targetClipCount: Number(clipCount) } } : {}),
      });
      setImportResult(res);
      if (youtubeSearchEnabled) refreshQuota();
      setSelected(new Map());
      setLinks("");
      const queued = new Map(res.queued.map((q) => [q.videoId, q.sourceVideoId]));
      setResults((rs) => rs.map((r) => (queued.has(r.videoId) ? { ...r, imported: { sourceVideoId: queued.get(r.videoId)!, status: "processing" } } : r)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6 pb-28">
      <div>
        <h1 className="text-2xl font-semibold">Discover</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Search YouTube or paste links, pick videos, and ClipForge downloads, clips, captions and renders them automatically.
        </p>
      </div>

      {youtubeSearchEnabled ? (
        <form
          className="card space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <div className="flex gap-2">
            <input className="input flex-1" placeholder="Search YouTube — e.g. “startup podcast interview”" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn-primary" disabled={loading || !q.trim()}>
              {loading ? "Searching…" : "Search"}
            </button>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <Select label="Length" value={filters.videoDuration} onChange={(v) => setFilters({ ...filters, videoDuration: v as Filters["videoDuration"] })} options={{ long: "Long (20 min+)", medium: "Medium (4–20 min)", any: "Any" }} />
            <Select label="Sort" value={filters.order} onChange={(v) => setFilters({ ...filters, order: v as Filters["order"] })} options={{ relevance: "Relevance", viewCount: "Most viewed", date: "Newest", rating: "Top rated" }} />
            <Select label="Uploaded" value={filters.publishedWithin} onChange={(v) => setFilters({ ...filters, publishedWithin: v })} options={{ any: "Any time", week: "This week", month: "This month", year: "This year" }} />
            <Select label="License" value={filters.videoLicense} onChange={(v) => setFilters({ ...filters, videoLicense: v as Filters["videoLicense"] })} options={{ any: "Any", creativeCommon: "Creative Commons" }} />
          </div>
          <QuotaMeter quota={quota} cached={cached} />
        </form>
      ) : (
        <div className="card p-4 text-sm text-zinc-400">
          YouTube search is off. Set <code className="text-zinc-200">YOUTUBE_API_KEY</code> on the API to search — or paste links below.
        </div>
      )}

      <div className="card p-4">
        <span className="label">Or paste YouTube links / IDs</span>
        <textarea
          className="input min-h-[64px] font-mono text-xs"
          placeholder="https://www.youtube.com/watch?v=…  (one per line)"
          value={links}
          onChange={(e) => setLinks(e.target.value)}
        />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {importResult && (
        <div className="card border-emerald-900/60 p-4 text-sm">
          <p className="text-emerald-300">
            {importResult.queued.length} video{importResult.queued.length === 1 ? "" : "s"} queued.{" "}
            <Link href="/library" className="underline">
              Watch progress in the Library →
            </Link>
          </p>
          {importResult.skipped.map((s) => (
            <p key={s.input} className="mt-1 text-zinc-400">
              Skipped <span className="font-mono text-xs">{s.input}</span>: {s.reason}
            </p>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {results.map((v) => {
          const isSel = selected.has(v.videoId);
          return (
            <button
              key={v.videoId}
              onClick={() => toggle(v)}
              className={`card overflow-hidden text-left transition ${
                isSel ? "border-brand-500 ring-2 ring-brand-500" : v.imported ? "opacity-60" : "hover:border-zinc-600"
              }`}
            >
              <div className="relative aspect-video bg-zinc-800">
                {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}
                {v.durationSeconds != null && (
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-xs tabular-nums">
                    {formatTime(v.durationSeconds)}
                  </span>
                )}
                {isSel && <span className="absolute left-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-brand-500 text-sm">✓</span>}
                {v.license === "creativeCommon" && (
                  <span className="absolute right-1.5 top-1.5 rounded bg-emerald-700/90 px-1.5 py-0.5 text-[10px] font-semibold">CC</span>
                )}
              </div>
              <div className="p-3">
                <h3 className="line-clamp-2 text-sm font-medium leading-snug">{v.title}</h3>
                <p className="mt-1 truncate text-xs text-zinc-400">{v.channelTitle}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {formatCount(v.viewCount)} views · {v.publishedAt ? formatDate(v.publishedAt) : ""}
                </p>
                {v.imported && (
                  <Link
                    href={`/videos/${v.imported.sourceVideoId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-1 inline-block text-xs text-brand-400 hover:underline"
                  >
                    Imported — open →
                  </Link>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {nextPage && (
        <div className="text-center">
          <button className="btn-secondary" disabled={loading} onClick={() => search(nextPage)}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}

      {total > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
            <span className="text-sm">
              <b>{total}</b> video{total === 1 ? "" : "s"} selected
            </span>
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              Clips per video
              <input
                className="input w-20 py-1"
                type="number"
                min={1}
                max={15}
                placeholder="auto"
                value={clipCount}
                onChange={(e) => setClipCount(e.target.value ? Number(e.target.value) : "")}
              />
            </label>
            <button className="btn-ghost" onClick={() => (setSelected(new Map()), setLinks(""))}>
              Clear
            </button>
            <button className="btn-primary ml-auto" disabled={importing} onClick={startImport}>
              {importing ? "Queuing…" : `Make shorts from ${total} video${total === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Record<string, string> }) {
  return (
    <label className="flex items-center gap-2 text-zinc-400">
      {label}
      <select className="input w-auto py-1" value={value} onChange={(e) => onChange(e.target.value)}>
        {Object.entries(options).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function DiscoverPage() {
  return (
    <AppShell>
      <Discover />
    </AppShell>
  );
}
