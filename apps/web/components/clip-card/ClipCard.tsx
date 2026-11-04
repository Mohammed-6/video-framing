"use client";

import type { Clip } from "@clipforge/contracts";
import Link from "next/link";
import { PublicationBadge } from "@/components/PlatformBadge";
import { ACTIVE_RENDER_STATUSES, formatTime } from "@/lib/format";

const STATUS_BADGE: Record<string, string> = {
  candidate: "bg-zinc-800 text-zinc-300",
  edited: "bg-sky-900/60 text-sky-300",
  rendered: "bg-violet-900/60 text-violet-300",
  published: "bg-emerald-900/60 text-emerald-300",
  discarded: "bg-zinc-800 text-zinc-500",
};

export function ClipCard({ clip, rank, onDiscard }: { clip: Clip; rank: number; onDiscard: () => void }) {
  const length = clip.endSeconds - clip.startSeconds;
  const score = Math.round((clip.score ?? 0) * 100);
  const render = clip.latestRender;
  const rendering = render && ACTIVE_RENDER_STATUSES.has(render.status);
  return (
    <div className="card flex flex-col p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-zinc-800 text-xs font-semibold text-zinc-300">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 font-medium leading-snug">{clip.title}</h3>
          <p className="mt-0.5 text-xs tabular-nums text-zinc-400">
            {formatTime(clip.startSeconds)} – {formatTime(clip.endSeconds)} · {Math.round(length)}s · rank {score}
          </p>
        </div>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${STATUS_BADGE[clip.status] ?? ""}`}>
          {clip.status}
        </span>
      </div>

      {clip.hook && <p className="mt-3 line-clamp-2 text-sm italic text-zinc-300">“{clip.hook}”</p>}
      {clip.selectionReason && <p className="mt-2 line-clamp-2 text-xs text-zinc-500">{clip.selectionReason}</p>}

      <div className="mt-3 space-y-1">
        {rendering && (
          <div>
            <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
              <span>Rendering</span>
              <span className="tabular-nums">{render.progressPercent}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full bg-brand-500 transition-all" style={{ width: `${render.progressPercent}%` }} />
            </div>
          </div>
        )}
        {render?.status === "failed" && <p className="text-xs text-red-400">Render failed: {render.errorMessage}</p>}
        {clip.publications?.map((p) => (
          <div key={p.id}>
            <PublicationBadge pub={p} />
          </div>
        ))}
      </div>

      <div className="mt-auto flex gap-2 pt-4">
        <Link href={`/clips/${clip.id}`} className="btn-primary flex-1 py-1.5">
          {clip.status === "rendered" ? "Review & publish" : "Edit"}
        </Link>
        {clip.status !== "published" && (
          <button className="btn-ghost py-1.5" onClick={onDiscard} title="Hide this clip">
            Discard
          </button>
        )}
      </div>
    </div>
  );
}
