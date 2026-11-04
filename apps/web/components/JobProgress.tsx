"use client";

import type { Job } from "@clipforge/contracts";
import { ACTIVE_JOB_STATUSES, STATUS_LABELS } from "@/lib/format";

const STEPS = ["downloading", "validating", "extracting_audio", "transcribing", "selecting_clips", "clips_ready"] as const;

export function JobProgress({ job, onCancel, compact }: { job: Job; onCancel?: () => void; compact?: boolean }) {
  const active = ACTIVE_JOB_STATUSES.has(job.status);
  const currentIdx = STEPS.indexOf(job.status as (typeof STEPS)[number]);

  if (job.status === "failed") {
    return (
      <div className="rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-sm">
        <p className="font-medium text-red-300">Processing failed</p>
        <p className="mt-1 text-red-200/80">{job.errorMessage ?? "Unknown error"}</p>
        {job.errorCode && <p className="mt-1 font-mono text-xs text-red-400/70">{job.errorCode}</p>}
      </div>
    );
  }
  if (!active) return null;

  return (
    <div className={compact ? "" : "rounded-lg border border-zinc-800 bg-zinc-900 p-4"}>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
        <span className="truncate font-medium">{job.stage ?? STATUS_LABELS[job.status]}</span>
        <span className="tabular-nums text-zinc-400">{job.progressPercent}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full bg-brand-500 transition-all duration-700" style={{ width: `${job.progressPercent}%` }} />
      </div>
      {!compact && (
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {STEPS.map((s, i) => (
            <li key={s} className={i < currentIdx ? "text-emerald-400" : i === currentIdx ? "text-white" : "text-zinc-600"}>
              {i < currentIdx ? "✓ " : ""}
              {STATUS_LABELS[s]}
            </li>
          ))}
        </ol>
      )}
      {job.status === "queued" && job.attempts > 0 && job.errorCode && (
        <p className="mt-2 text-xs text-amber-400">Retrying after a temporary error ({job.errorCode})</p>
      )}
      {onCancel && (
        <button className="btn-ghost mt-2 px-2 py-1 text-xs" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
