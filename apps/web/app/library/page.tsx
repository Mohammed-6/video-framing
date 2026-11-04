"use client";

import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { JobProgress } from "@/components/JobProgress";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { api } from "@/lib/api";
import { ACTIVE_JOB_STATUSES, formatDate, formatTime } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

function Library() {
  const { data, error, refresh } = usePolling(() => api.listVideos(), {
    intervalMs: 3000,
    // Keep polling while anything is processing or clips are still rendering.
    shouldPoll: (d) =>
      d.videos.some(
        (v) =>
          (v.latestJob && ACTIVE_JOB_STATUSES.has(v.latestJob.status)) ||
          (v.clipCounts && v.latestJob?.status === "clips_ready" && v.clipCounts.rendered + v.clipCounts.published < v.clipCounts.total),
      ),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Library</h1>
          <p className="mt-1 text-sm text-zinc-400">Every imported video and how far it is through the pipeline.</p>
        </div>
        <div className="flex items-center gap-3">
          <UploadPanel onQueued={refresh} />
          <Link href="/discover" className="btn-primary">
            Find videos
          </Link>
        </div>
      </div>

      {error && !data && <p className="text-red-400">{error.message}</p>}
      {data?.videos.length === 0 && (
        <div className="card p-10 text-center text-zinc-400">
          Nothing here yet.{" "}
          <Link href="/discover" className="text-brand-400 hover:underline">
            Search YouTube
          </Link>{" "}
          to import your first video.
        </div>
      )}

      <div className="space-y-3">
        {data?.videos.map((v) => {
          const job = v.latestJob;
          const active = job && ACTIVE_JOB_STATUSES.has(job.status);
          return (
            <Link key={v.id} href={`/videos/${v.id}`} className="card flex gap-4 p-3 transition hover:border-zinc-600">
              <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-md bg-zinc-800">
                {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
                {v.durationSeconds != null && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[11px] tabular-nums">{formatTime(v.durationSeconds)}</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-medium">{v.title}</h2>
                <p className="text-xs text-zinc-500">
                  {v.origin === "youtube" ? v.channelTitle ?? "YouTube" : "Uploaded file"} · added {formatDate(v.createdAt)}
                </p>
                <div className="mt-2">
                  {active && job ? (
                    <JobProgress job={job} compact />
                  ) : job?.status === "failed" ? (
                    <p className="line-clamp-2 text-sm text-red-400">Failed: {job.errorMessage}</p>
                  ) : job?.status === "cancelled" ? (
                    <p className="text-sm text-zinc-500">Cancelled</p>
                  ) : v.clipCounts ? (
                    <p className="text-sm text-zinc-300">
                      {v.clipCounts.total} clips · <span className="text-violet-300">{v.clipCounts.rendered} ready to review</span> ·{" "}
                      <span className="text-emerald-300">{v.clipCounts.published} published</span>
                      {v.clipCounts.rendered + v.clipCounts.published < v.clipCounts.total && (
                        <span className="text-zinc-500"> · rendering…</span>
                      )}
                    </p>
                  ) : null}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function LibraryPage() {
  return (
    <AppShell>
      <Library />
    </AppShell>
  );
}
