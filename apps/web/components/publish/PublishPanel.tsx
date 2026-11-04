"use client";

import { PLATFORM_LABELS, type Platform, type Publication, type PublishPreview } from "@clipforge/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PlatformDot, PublicationBadge } from "@/components/PlatformBadge";
import { api, errorMessage } from "@/lib/api";

type Draft = PublishPreview & { selected: boolean };

/**
 * Approve a rendered clip for publishing: per-platform title/caption (pre-filled from
 * each platform's template), then publish.
 */
export function PublishPanel({
  clipId,
  drafts: initial,
  readyPlatforms,
  publications = [],
  disabledReason,
  onPublished,
}: {
  clipId: string;
  drafts: PublishPreview[];
  readyPlatforms: Platform[];
  publications?: Publication[];
  disabledReason?: string;
  onPublished: (pubs: Publication[]) => void;
}) {
  const live = new Set(publications.filter((p) => ["queued", "publishing", "published"].includes(p.status)).map((p) => p.platform));
  const usable = initial.filter((d) => readyPlatforms.includes(d.platform) && !live.has(d.platform));
  const [drafts, setDrafts] = useState<Draft[]>(usable.map((d) => ({ ...d, selected: true })));
  const [expanded, setExpanded] = useState<Platform | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the parent loads new drafts (e.g. after a title edit).
  const key = usable.map((d) => d.platform + d.title + d.description).join("|");
  useEffect(() => {
    setDrafts(usable.map((d) => ({ ...d, selected: true })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = (p: Platform, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.platform === p ? { ...d, ...patch } : d)));
  const selected = drafts.filter((d) => d.selected);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.publishClip(clipId, {
        targets: selected.map((d) => ({ platform: d.platform, title: d.title, description: d.description })),
      });
      onPublished(res.publications);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {publications.length > 0 && (
        <div className="space-y-1">
          {publications.map((p) => (
            <div key={p.id}>
              <PublicationBadge pub={p} />
              {p.status === "failed" && <p className="ml-4 text-xs text-red-400/80">{p.errorMessage}</p>}
            </div>
          ))}
        </div>
      )}

      {readyPlatforms.length === 0 ? (
        <p className="text-sm text-zinc-400">
          No platforms connected yet.{" "}
          <Link href="/settings" className="text-brand-400 hover:underline">
            Connect YouTube, Facebook or Instagram
          </Link>
          .
        </p>
      ) : drafts.length === 0 ? (
        <p className="text-sm text-zinc-500">Sent to every connected platform.</p>
      ) : (
        <>
          {drafts.map((d) => (
            <div key={d.platform} className="rounded-lg border border-zinc-800 bg-zinc-950/60">
              <div className="flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={d.selected}
                  onChange={(e) => update(d.platform, { selected: e.target.checked })}
                  className="h-4 w-4 accent-brand-500"
                />
                <PlatformDot platform={d.platform} />
                <span className="text-sm font-medium">{PLATFORM_LABELS[d.platform]}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{d.title}</span>
                <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setExpanded(expanded === d.platform ? null : d.platform)}>
                  {expanded === d.platform ? "Done" : "Edit text"}
                </button>
              </div>
              {expanded === d.platform && (
                <div className="space-y-2 border-t border-zinc-800 p-3">
                  <input className="input" value={d.title} maxLength={100} onChange={(e) => update(d.platform, { title: e.target.value })} />
                  <textarea
                    className="input min-h-[120px] font-mono text-xs"
                    value={d.description}
                    maxLength={2200}
                    onChange={(e) => update(d.platform, { description: e.target.value })}
                  />
                </div>
              )}
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary ml-auto" disabled={busy || !selected.length || Boolean(disabledReason)} onClick={publish}>
              {busy ? "Sending…" : `Publish now (${selected.length})`}
            </button>
          </div>
          {disabledReason && <p className="text-xs text-amber-400">{disabledReason}</p>}
        </>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
