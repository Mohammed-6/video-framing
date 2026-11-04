"use client";

import { PLATFORM_LABELS } from "@clipforge/contracts";
import Link from "next/link";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PlatformDot } from "@/components/PlatformBadge";
import { api, errorMessage } from "@/lib/api";
import { ACTIVE_PUBLISH_STATUSES, STATUS_LABELS, formatDateTime } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

const FILTERS = ["", "queued", "publishing", "published", "failed"] as const;

function Publications() {
  const [status, setStatus] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const { data, refresh } = usePolling(() => api.publications(status || undefined), {
    intervalMs: 4000,
    shouldPoll: (d) => d.publications.some((p) => ACTIVE_PUBLISH_STATUSES.has(p.status)),
    deps: [status],
  });

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Published</h1>
          <p className="mt-1 text-sm text-zinc-400">Every post: waiting, in progress, live, or failed.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-zinc-900 p-1 text-sm">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatus(f)}
              className={`rounded-md px-3 py-1 ${status === f ? "bg-zinc-800 text-white" : "text-zinc-400"}`}
            >
              {f ? STATUS_LABELS[f] : "All"}
            </button>
          ))}
        </div>
      </div>
      {msg && <p className="text-sm text-red-400">{msg}</p>}
      <div className="card divide-y divide-zinc-800">
        {data?.publications.length === 0 && <p className="p-6 text-center text-sm text-zinc-500">No posts yet.</p>}
        {data?.publications.map((p) => {
          return (
            <div key={p.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <PlatformDot platform={p.platform} />
              <span className="w-32 shrink-0 text-zinc-400">{PLATFORM_LABELS[p.platform]}</span>
              <Link href={`/clips/${p.clipId}`} className="min-w-0 flex-1 truncate hover:underline">
                {p.title}
              </Link>
              <span className="text-xs text-zinc-500">{formatDateTime(p.completedAt ?? p.createdAt)}</span>
              <span
                className={`w-28 text-right text-xs ${
                  p.status === "published" ? "text-emerald-300" : p.status === "failed" ? "text-red-400" : "text-amber-300"
                }`}
              >
                {STATUS_LABELS[p.status]}
                {p.status === "publishing" && ` ${p.progressPercent}%`}
              </span>
              <span className="flex w-28 justify-end gap-1">
                {p.externalUrl && (
                  <a href={p.externalUrl} target="_blank" rel="noreferrer" className="btn-ghost px-2 py-0.5 text-xs">
                    View ↗
                  </a>
                )}
                {p.status === "queued" && (
                  <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => act(() => api.cancelPublication(p.id))}>
                    Cancel
                  </button>
                )}
                {(p.status === "failed" || p.status === "cancelled") && (
                  <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => act(() => api.retryPublication(p.id))}>
                    Retry
                  </button>
                )}
              </span>
              {p.status === "failed" && p.errorMessage && <p className="basis-full pl-6 text-xs text-red-400/80">{p.errorMessage}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PublicationsPage() {
  return (
    <AppShell>
      <Publications />
    </AppShell>
  );
}
