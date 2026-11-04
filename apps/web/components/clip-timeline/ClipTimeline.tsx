"use client";

import type { TranscriptWord } from "@clipforge/contracts";
import { useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/format";

const MIN_LEN = 3;
const MAX_LEN = 180;
const SNAP_SECONDS = 0.2;

type Props = {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  words: TranscriptWord[];
  onChange: (start: number, end: number) => void;
  onSeek: (t: number) => void;
};

function snapToWord(t: number, words: TranscriptWord[], edge: "start" | "end"): number {
  let best = t;
  let bestD = SNAP_SECONDS;
  for (const w of words) {
    const candidate = edge === "start" ? w.start : w.end;
    const d = Math.abs(candidate - t);
    if (d < bestD) {
      best = candidate;
      bestD = d;
    }
  }
  return best;
}

/**
 * Two-level timeline: an overview of the whole source and a zoomed detail track
 * with draggable in/out handles that snap to word boundaries.
 */
export function ClipTimeline({ duration, start, end, currentTime, words, onChange, onSeek }: Props) {
  const detailRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const suppressClick = useRef(false);
  const computeWindow = () => {
    const pad = Math.max(10, (end - start) * 0.5);
    return { from: Math.max(0, start - pad), to: Math.min(duration, end + pad) };
  };
  // Freeze the zoom window while dragging so the track doesn't move under the cursor.
  const [win, setWin] = useState(computeWindow);
  useEffect(() => {
    if (!dragging) setWin(computeWindow());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, duration, dragging]);

  const span = Math.max(0.001, win.to - win.from);
  const pct = (t: number) => `${((t - win.from) / span) * 100}%`;

  function timeAt(clientX: number): number {
    const rect = detailRef.current!.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    return win.from + (x / rect.width) * span;
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    const raw = timeAt(e.clientX);
    if (dragging === "start") {
      let s = e.altKey ? raw : snapToWord(raw, words, "start");
      s = Math.max(0, Math.min(s, end - MIN_LEN));
      s = Math.max(s, end - MAX_LEN);
      onChange(round(s), end);
    } else {
      let en = e.altKey ? raw : snapToWord(raw, words, "end");
      en = Math.min(duration, Math.max(en, start + MIN_LEN));
      en = Math.min(en, start + MAX_LEN);
      onChange(start, round(en));
    }
  }

  const visibleWords = words.filter((w) => w.end >= win.from && w.start <= win.to);

  return (
    <div className="select-none space-y-3">
      {/* Overview */}
      <div
        className="relative h-3 cursor-pointer rounded-full bg-zinc-800"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - rect.left) / rect.width) * duration);
        }}
        title="Whole video"
      >
        <div
          className="absolute inset-y-0 rounded-full bg-brand-500/70"
          style={{ left: `${(start / duration) * 100}%`, width: `${Math.max(0.4, ((end - start) / duration) * 100)}%` }}
        />
        <div className="absolute inset-y-[-3px] w-0.5 bg-white" style={{ left: `${(currentTime / duration) * 100}%` }} />
      </div>

      {/* Detail */}
      <div
        ref={detailRef}
        className="relative h-16 cursor-pointer overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-zinc-800"
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          if (dragging) suppressClick.current = true;
          setDragging(null);
        }}
        onPointerCancel={() => setDragging(null)}
        onClick={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          onSeek(timeAt(e.clientX));
        }}
      >
        {visibleWords.map((w, i) => (
          <div
            key={i}
            className="absolute bottom-2 top-2 rounded-sm bg-zinc-700/60"
            style={{ left: pct(w.start), width: `${((w.end - w.start) / span) * 100}%` }}
            title={w.word}
          />
        ))}
        <div className="absolute inset-y-0 bg-brand-500/25 ring-2 ring-inset ring-brand-500" style={{ left: pct(start), width: `${((end - start) / span) * 100}%` }} />
        {(["start", "end"] as const).map((edge) => (
          <div
            key={edge}
            role="slider"
            aria-label={edge === "start" ? "Clip start" : "Clip end"}
            aria-valuenow={edge === "start" ? start : end}
            className="absolute inset-y-0 z-10 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center bg-brand-500 hover:bg-brand-400"
            style={{ left: pct(edge === "start" ? start : end) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.parentElement!.setPointerCapture(e.pointerId);
              setDragging(edge);
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="h-6 w-0.5 rounded bg-white/80" />
          </div>
        ))}
        <div className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-white" style={{ left: pct(currentTime) }} />
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-zinc-500">
        <span>{formatTime(win.from)}</span>
        <span>Drag handles to trim · snaps to words (hold Alt to disable)</span>
        <span>{formatTime(win.to)}</span>
      </div>
    </div>
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;
