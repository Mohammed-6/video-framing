"use client";

import type { BrandInclude, BrandKit, ReviewItem } from "@clipforge/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { IncludeToggles } from "@/components/IncludeToggles";
import { PublishPanel } from "@/components/publish/PublishPanel";
import { api, errorMessage, startDownload } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

function RenderedPreview({ renderId }: { renderId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    api.renderPlayback(renderId).then((p) => setSrc(p.url), () => setSrc(null));
  }, [renderId]);
  return (
    <div className="aspect-[9/16] w-full overflow-hidden rounded-lg bg-black">
      {src && <video src={src} controls playsInline preload="metadata" className="h-full w-full" />}
    </div>
  );
}

function ReviewCard({
  item,
  readyPlatforms,
  onDone,
  brandKit,
  defaultInclude,
}: {
  item: ReviewItem;
  readyPlatforms: ReviewItem["drafts"][number]["platform"][];
  onDone: () => void;
  brandKit: BrandKit | null;
  defaultInclude: BrandInclude;
}) {
  const [busy, setBusy] = useState(false);
  const rendered: BrandInclude = { ...defaultInclude, ...(item.latestRender.included ?? {}) };
  const [include, setInclude] = useState<BrandInclude>(rendered);
  const [rerenderError, setRerenderError] = useState<string | null>(null);
  const changed = (Object.keys(include) as (keyof BrandInclude)[]).some((k) => include[k] !== rendered[k]);
  return (
    <div className="card grid gap-5 p-4 md:grid-cols-[220px_1fr]">
      <RenderedPreview renderId={item.latestRender.id} />
      <div className="min-w-0 space-y-3">
        <div>
          <h2 className="font-medium">{item.title}</h2>
          <p className="text-xs text-zinc-500">
            From <span className="text-zinc-300">{item.sourceVideo.title}</span> · {formatTime(item.startSeconds)}–{formatTime(item.endSeconds)} ·{" "}
            {Math.round(item.endSeconds - item.startSeconds)}s · rank {Math.round((item.score ?? 0) * 100)}
          </p>
          {item.selectionReason && <p className="mt-1 text-xs text-zinc-500">{item.selectionReason}</p>}
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-zinc-500">In this short:</span>
            <IncludeToggles value={include} onChange={setInclude} brandKit={brandKit} size="xs" />
            {changed && (
              <button
                className="btn-secondary ml-auto py-1 text-xs"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setRerenderError(null);
                  try {
                    await api.renderClip(item.id, { include });
                    onDone(); // it comes back here when the new render is ready
                  } catch (e) {
                    setRerenderError(errorMessage(e));
                    setBusy(false);
                  }
                }}
              >
                Re-render with changes
              </button>
            )}
          </div>
          {rerenderError && <p className="mt-1 text-xs text-red-400">{rerenderError}</p>}
        </div>
        <PublishPanel
          clipId={item.id}
          drafts={item.drafts}
          readyPlatforms={readyPlatforms}
          onPublished={onDone}
          disabledReason={changed ? "Re-render first (or undo the changes) to publish" : undefined}
        />
        <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
          <Link href={`/clips/${item.id}`} className="btn-secondary py-1.5 text-xs">
            Edit trim / captions
          </Link>
          <button
            className="btn-ghost py-1.5 text-xs"
            onClick={async () => {
              const d = await api.downloadUrl(item.latestRender.id);
              startDownload(d.url, d.fileName);
            }}
          >
            Download MP4
          </button>
          <button
            className="btn-ghost ml-auto py-1.5 text-xs text-zinc-400"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.updateClip(item.id, { status: "discarded" }).catch(() => undefined);
              onDone();
            }}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

function Review() {
  const { data, error, refresh, setData } = usePolling(() => api.review(), {
    intervalMs: 5000,
    shouldPoll: (d) => d.pending.rendering + d.pending.analyzing > 0,
  });

  const [kit, setKit] = useState<{ brandKit: BrandKit; include: BrandInclude } | null>(null);
  useEffect(() => {
    api.settings().then((s) => setKit({ brandKit: s.settings.render.brandKit, include: s.settings.render.include }), () => undefined);
  }, []);

  const remove = (id: string) => setData((d) => (d ? { ...d, items: d.items.filter((i) => i.id !== id) } : d));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Review</h1>
          <p className="mt-1 text-sm text-zinc-400">Rendered shorts waiting for your OK. Publish, edit or skip.</p>
        </div>
        {data && data.pending.rendering + data.pending.analyzing > 0 && (
          <p className="text-sm text-zinc-400">
            {data.pending.analyzing > 0 && `${data.pending.analyzing} video(s) processing · `}
            {data.pending.rendering} clip(s) rendering…
          </p>
        )}
      </div>
      {error && !data && <p className="text-red-400">{error.message}</p>}
      {data && data.readyPlatforms.length === 0 && (
        <div className="card border-amber-900/60 p-4 text-sm text-amber-200">
          No publishing platform is connected and enabled.{" "}
          <Link href="/settings" className="underline">
            Set up YouTube, Facebook or Instagram
          </Link>{" "}
          — you can still download clips meanwhile.
        </div>
      )}
      {data?.items.length === 0 && (
        <div className="card p-10 text-center text-zinc-400">
          Nothing to review.{" "}
          <Link href="/discover" className="text-brand-400 hover:underline">
            Find more videos
          </Link>
          .
        </div>
      )}
      <div className="space-y-4">
        {data?.items.map((item) => (
          <ReviewCard
            key={item.id}
            item={item}
            readyPlatforms={data.readyPlatforms}
            brandKit={kit?.brandKit ?? null}
            defaultInclude={kit?.include ?? { intro: true, outro: true, music: true, logo: true, captions: true }}
            onDone={() => {
              remove(item.id);
              refresh();
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function ReviewPage() {
  return (
    <AppShell>
      <Review />
    </AppShell>
  );
}
