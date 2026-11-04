"use client";

import type { Clip } from "@clipforge/contracts";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ClipCard } from "@/components/clip-card/ClipCard";
import { JobProgress } from "@/components/JobProgress";
import { api, errorMessage } from "@/lib/api";
import { ACTIVE_JOB_STATUSES, ACTIVE_PUBLISH_STATUSES, ACTIVE_RENDER_STATUSES, formatTime } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

function VideoView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);

  const video = usePolling(() => api.getVideo(id), {
    shouldPoll: (v) => Boolean(v.latestJob && ACTIVE_JOB_STATUSES.has(v.latestJob.status)),
    deps: [id],
  });
  const jobStatus = video.data?.latestJob?.status;
  const clips = usePolling(() => api.listClips(id), {
    intervalMs: 3000,
    shouldPoll: (d) =>
      jobStatus !== "clips_ready" ||
      d.clips.some(
        (c) =>
          (c.latestRender && ACTIVE_RENDER_STATUSES.has(c.latestRender.status)) ||
          c.publications?.some((p) => ACTIVE_PUBLISH_STATUSES.has(p.status)),
      ),
    deps: [id, jobStatus],
  });

  const v = video.data;
  if (video.error && !v) return <p className="text-red-400">{video.error.message}</p>;
  if (!v) return <p className="text-zinc-500">Loading…</p>;
  const job = v.latestJob;
  const active = job && ACTIVE_JOB_STATUSES.has(job.status);

  async function discard(clip: Clip) {
    await api.updateClip(clip.id, { status: "discarded" });
    clips.setData((d) => (d ? { clips: d.clips.filter((c) => c.id !== clip.id) } : d));
  }

  async function rerun() {
    setMsg(null);
    try {
      await api.analyze(id);
      video.refresh();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  }

  async function remove() {
    if (!window.confirm("Delete this video, its clips and renders? Published posts stay on the platforms.")) return;
    try {
      await api.deleteVideo(id);
      router.push("/library");
    } catch (e) {
      setMsg(errorMessage(e));
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <Link href="/library" className="text-sm text-zinc-500 hover:text-white">
          ← Library
        </Link>
        <div className="mt-2 flex flex-wrap items-start gap-4">
          {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="aspect-video w-48 rounded-lg object-cover" />}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold">{v.title}</h1>
            <p className="mt-1 text-sm text-zinc-400">
              {v.channelTitle ?? (v.origin === "upload" ? "Uploaded file" : "")}
              {v.durationSeconds ? ` · ${formatTime(v.durationSeconds)}` : ""}
              {v.width ? ` · ${v.width}×${v.height}` : ""}
              {v.license === "creativeCommon" ? " · Creative Commons" : ""}
            </p>
            {v.sourceUrl && (
              <a href={v.sourceUrl} target="_blank" rel="noreferrer" className="text-sm text-brand-400 hover:underline">
                Open on YouTube ↗
              </a>
            )}
          </div>
          <div className="flex gap-2">
            {!active && (
              <button className="btn-secondary" onClick={rerun}>
                Re-run analysis
              </button>
            )}
            <button className="btn-ghost text-red-400" onClick={remove}>
              Delete
            </button>
          </div>
        </div>
      </div>
      {msg && <p className="text-sm text-red-400">{msg}</p>}

      {job && (
        <JobProgress
          job={job}
          onCancel={active ? async () => (await api.cancelJob(job.id).catch(() => undefined), video.refresh()) : undefined}
        />
      )}

      {jobStatus === "clips_ready" && (
        <section className="space-y-4">
          <p className="text-sm text-zinc-400">
            {clips.data?.clips.length ?? 0} clips, ranked best first. {job?.stage && <span className="text-zinc-500">({job.stage})</span>}
          </p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {clips.data?.clips.map((c, i) => <ClipCard key={c.id} clip={c} rank={i + 1} onDiscard={() => discard(c)} />)}
          </div>
        </section>
      )}
    </div>
  );
}

export default function VideoPage() {
  return (
    <AppShell>
      <VideoView />
    </AppShell>
  );
}
