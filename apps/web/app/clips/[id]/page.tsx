"use client";

import {
  CAPTION_STYLES,
  CAPTION_STYLE_LABELS,
  type CaptionStyle,
  type BrandInclude,
  type BrandKit,
  type ClipDetail,
  type Platform,
  type PublishPreview,
  type RenderJob,
  type Resolution,
} from "@clipforge/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { IncludeToggles } from "@/components/IncludeToggles";
import { ClipTimeline } from "@/components/clip-timeline/ClipTimeline";
import { PublishPanel } from "@/components/publish/PublishPanel";
import { ClipPlayer } from "@/components/video-player/ClipPlayer";
import { ApiError, api, startDownload } from "@/lib/api";
import { flattenWords } from "@/lib/captions";
import { ACTIVE_RENDER_STATUSES, STATUS_LABELS, formatBytes, formatTime } from "@/lib/format";

type Draft = { start: number; end: number; title: string; hook: string; cropCenterX: number; cropZoom: number; reframeMode: "auto" | "fixed" };

function Editor() {
  const { id } = useParams<{ id: string }>();
  const [clip, setClip] = useState<ClipDetail | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [time, setTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Render options
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>("bold_pop");
  const [resolution, setResolution] = useState<Resolution>("1080x1920");
  const [highlight, setHighlight] = useState("#FFE14D");
  const [position, setPosition] = useState<"bottom" | "middle">("bottom");
  const [watermark, setWatermark] = useState("");
  const [render, setRender] = useState<RenderJob | null>(null);
  const [renders, setRenders] = useState<RenderJob[]>([]);

  const [drafts, setDrafts] = useState<PublishPreview[]>([]);
  const [readyPlatforms, setReadyPlatforms] = useState<Platform[]>([]);
  const [multiFace, setMultiFace] = useState<"group" | "speaker">("group");
  const [letterboxFill, setLetterboxFill] = useState<"blur" | "black">("blur");
  const [brandKit, setBrandKit] = useState<BrandKit | null>(null);
  const [include, setInclude] = useState<BrandInclude>({ intro: true, outro: true, music: true, logo: true, captions: true });
  const [steadyZoom, setSteadyZoom] = useState(true);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  async function reloadClip() {
    const [c, d] = await Promise.all([api.getClip(id), api.drafts(id)]);
    setClip(c);
    setDrafts(d.drafts);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await api.getClip(id);
        const [pb, list, settings, platforms, d] = await Promise.all([
          api.playback(c.sourceVideoId),
          api.listRenders(id),
          api.settings(),
          api.platforms(),
          api.drafts(id),
        ]);
        if (cancelled) return;
        const r = settings.settings.render;
        setCaptionStyle(r.captionStyle);
        setMultiFace(r.multiFace);
        setSteadyZoom(r.steadyZoom);
        // Start from what the last render used, so re-rendering keeps your choices.
        setInclude({ ...r.include, ...(list.renders[0]?.included ?? {}) });
        setLetterboxFill(r.letterboxFill);
        setBrandKit(r.brandKit);
        if (r.brandKit.logoAssetId) {
          api.assetUrl(r.brandKit.logoAssetId).then((u) => setLogoUrl(u.url), () => setLogoUrl(null));
        }
        setResolution(r.resolution);
        setHighlight(r.brand.primaryColor ?? "#FFE14D");
        setPosition(r.brand.captionPosition);
        setWatermark(r.brand.watermarkText ?? "");
        setDrafts(d.drafts);
        setReadyPlatforms(platforms.platforms.filter((p) => p.enabled && p.connected).map((p) => p.platform));
        setClip(c);
        setSrc(pb.url);
        setDraft({ start: c.startSeconds, end: c.endSeconds, title: c.title, hook: c.hook ?? "", cropCenterX: c.cropCenterX, cropZoom: c.cropZoom, reframeMode: c.reframeMode });
        setRenders(list.renders);
        setRender(list.renders[0] ?? null);
        setTime(c.startSeconds);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : "Failed to load clip");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Poll the active render.
  useEffect(() => {
    if (!render || !ACTIVE_RENDER_STATUSES.has(render.status)) return;
    const t = setTimeout(async () => {
      try {
        const r = await api.getRender(render.id);
        setRender(r);
        if (!ACTIVE_RENDER_STATUSES.has(r.status)) {
          setRenders((rs) => rs.map((x) => (x.id === r.id ? r : x)));
          await reloadClip(); // clip status becomes "rendered"
        }
      } catch {
        /* retry on next tick */
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [render]);

  const words = useMemo(() => (clip ? flattenWords(clip.transcriptSegments) : []), [clip]);
  const clipWords = useMemo(
    () => (draft ? words.filter((w) => w.end > draft.start && w.start < draft.end) : []),
    [words, draft],
  );

  if (loadError) return <p className="text-red-400">{loadError}</p>;
  if (!clip || !draft || !src) return <p className="text-zinc-500">Loading editor…</p>;

  const duration = clip.sourceVideo.durationSeconds ?? draft.end;
  const dirty =
    draft.start !== clip.startSeconds ||
    draft.end !== clip.endSeconds ||
    draft.title !== clip.title ||
    draft.hook !== (clip.hook ?? "") ||
    draft.cropCenterX !== clip.cropCenterX ||
    draft.reframeMode !== clip.reframeMode ||
    draft.cropZoom !== clip.cropZoom;
  const rendering = render ? ACTIVE_RENDER_STATUSES.has(render.status) : false;

  function seek(t: number) {
    const v = videoRef.current;
    if (v) v.currentTime = t;
    setTime(t);
  }

  async function save(): Promise<boolean> {
    if (!draft || !clip) return false;
    setSaving(true);
    setMessage(null);
    try {
      const updated = await api.updateClip(clip.id, {
        startSeconds: draft.start,
        endSeconds: draft.end,
        title: draft.title,
        hook: draft.hook,
        cropCenterX: draft.cropCenterX,
        reframeMode: draft.reframeMode,
        cropZoom: draft.cropZoom,
      });
      setClip({ ...clip, ...updated });
      setDraft({ start: updated.startSeconds, end: updated.endSeconds, title: updated.title, hook: updated.hook ?? "", cropCenterX: updated.cropCenterX, cropZoom: updated.cropZoom, reframeMode: updated.reframeMode });
      setMessage({ kind: "ok", text: "Saved" });
      return true;
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof ApiError ? e.message : "Save failed" });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function startRender() {
    if (dirty && !(await save())) return;
    setMessage(null);
    try {
      const r = await api.renderClip(clip!.id, {
        aspectRatio: "9:16",
        captionStyle,
        resolution,
        multiFace,
        steadyZoom,
        letterboxFill,
        include,
        brand: {
          captionPosition: position,
          primaryColor: highlight,
          ...(watermark.trim() ? { watermarkText: watermark.trim() } : {}),
        },
      });
      setRender(r);
      setRenders((rs) => [r, ...rs]);
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof ApiError ? e.message : "Render failed to start" });
    }
  }

  async function download(r: RenderJob) {
    try {
      const d = await api.downloadUrl(r.id);
      startDownload(d.url, d.fileName);
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof ApiError ? e.message : "Download failed" });
    }
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const nudge = (edge: "start" | "end", delta: number) => {
    if (edge === "start") set({ start: Math.max(0, Math.min(draft.end - 3, +(draft.start + delta).toFixed(3))) });
    else set({ end: Math.min(duration, Math.max(draft.start + 3, +(draft.end + delta).toFixed(3))) });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/videos/${clip.sourceVideoId}`} className="text-sm text-zinc-500 hover:text-white">
            ← Back to clips
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{clip.title}</h1>
        </div>
        <div className="flex items-center gap-3">
          {message && <span className={`text-sm ${message.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>{message.text}</span>}
          <button className="btn-secondary" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[360px_1fr]">
        {/* Preview */}
        <div>
          <ClipPlayer
            src={src}
            videoRef={videoRef}
            start={draft.start}
            end={draft.end}
            cropCenterX={draft.cropCenterX}
            cropZoom={draft.reframeMode === "fixed" ? draft.cropZoom : 0}
            track={
              draft.reframeMode === "auto" && !dirty && clip.status !== "edited" && clip.latestRender?.status === "completed"
                ? clip.latestRender.reframeTrack
                : null
            }
            sourceWidth={clip.sourceVideo.width}
            sourceHeight={clip.sourceVideo.height}
            words={clipWords}
            captionStyle={include.captions ? captionStyle : "none"}
            highlightColor={highlight}
            captionPosition={position}
            watermark={watermark.trim() || undefined}
            letterboxFill={letterboxFill}
            logo={
              include.logo && logoUrl && brandKit
                ? { url: logoUrl, position: brandKit.logoPosition, scale: brandKit.logoScale, opacity: brandKit.logoOpacity }
                : null
            }
            onTime={setTime}
          />
          <div className="mx-auto mt-5 max-w-[340px] space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand-500"
                checked={draft.reframeMode === "auto"}
                onChange={(e) => set({ reframeMode: e.target.checked ? "auto" : "fixed" })}
              />
              Auto framing (follow faces)
              <span className="text-xs text-zinc-500">
                {draft.reframeMode === "auto"
                  ? clip.latestRender?.reframeTrack && !dirty
                    ? "· preview = last render"
                    : "· applied when you render"
                  : ""}
              </span>
            </label>
            {draft.reframeMode === "auto" ? (
              <label className="block">
                <span className="label">With several people on screen</span>
                <select
                  className="input"
                  value={multiFace === "speaker" ? "speaker" : steadyZoom ? "steady" : "switch"}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMultiFace(v === "speaker" ? "speaker" : "group");
                    setSteadyZoom(v !== "switch");
                  }}
                >
                  <option value="steady">Show everyone, one steady layout for the whole clip</option>
                  <option value="switch">Show everyone, switch between tight and wide</option>
                  <option value="speaker">Follow the speaker (tight crop)</option>
                </select>
                <span className="mt-1 block text-[11px] text-zinc-500">Takes effect on the next render.</span>
              </label>
            ) : (
              <>
                <label className="block">
                  <span className="label">Position</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={draft.cropCenterX}
                    onChange={(e) => set({ cropCenterX: +e.target.value })}
                    className="w-full accent-brand-500"
                  />
                  <div className="flex justify-between text-[11px] text-zinc-500">
                    <span>Left</span>
                    <button className="hover:text-white" onClick={() => set({ cropCenterX: 0.5 })}>
                      Center
                    </button>
                    <span>Right</span>
                  </div>
                </label>
                <label className="block">
                  <span className="label">Zoom out</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={draft.cropZoom}
                    onChange={(e) => set({ cropZoom: +e.target.value })}
                    className="w-full accent-brand-500"
                  />
                  <div className="flex justify-between text-[11px] text-zinc-500">
                    <span>Fill 9:16</span>
                    <span>Whole scene (black bars)</span>
                  </div>
                </label>
              </>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="min-w-0 space-y-6">
          <div className="card space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Trim</h2>
              <span className="text-sm tabular-nums text-zinc-400">{(draft.end - draft.start).toFixed(1)}s</span>
            </div>
            <ClipTimeline
              duration={duration}
              start={draft.start}
              end={draft.end}
              currentTime={time}
              words={words}
              onChange={(start, end) => set({ start, end })}
              onSeek={seek}
            />
            <div className="grid grid-cols-2 gap-4">
              {(["start", "end"] as const).map((edge) => (
                <div key={edge}>
                  <span className="label">{edge === "start" ? "In" : "Out"}</span>
                  <div className="flex items-center gap-1">
                    <button className="btn-ghost px-2 py-1" onClick={() => nudge(edge, -0.5)}>
                      −0.5s
                    </button>
                    <span className="flex-1 text-center font-mono text-sm tabular-nums">{formatTime(draft[edge], true)}</span>
                    <button className="btn-ghost px-2 py-1" onClick={() => nudge(edge, 0.5)}>
                      +0.5s
                    </button>
                  </div>
                  <button
                    className="btn-ghost mt-1 w-full py-1 text-xs"
                    onClick={() =>
                      edge === "start"
                        ? set({ start: Math.min(+time.toFixed(3), draft.end - 3) })
                        : set({ end: Math.max(+time.toFixed(3), draft.start + 3) })
                    }
                  >
                    Set to playhead ({formatTime(time, true)})
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="card space-y-4 p-5">
            <h2 className="font-medium">Details</h2>
            <label className="block">
              <span className="label">Title</span>
              <input className="input" maxLength={100} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
            </label>
            <label className="block">
              <span className="label">Hook</span>
              <textarea className="input min-h-[64px]" maxLength={300} value={draft.hook} onChange={(e) => set({ hook: e.target.value })} />
            </label>
            {clip.selectionReason && (
              <p className="text-xs text-zinc-500">
                <span className="font-medium text-zinc-400">Why this clip:</span> {clip.selectionReason}
              </p>
            )}
            <div>
              <span className="label">Transcript</span>
              <p className="max-h-40 overflow-y-auto rounded-lg bg-zinc-950 p-3 text-sm leading-relaxed text-zinc-300">
                {clipWords.length
                  ? clipWords.map((w, i) => (
                      <span
                        key={i}
                        onClick={() => seek(w.start)}
                        className={`cursor-pointer rounded hover:bg-zinc-800 ${time >= w.start && time < w.end ? "bg-brand-500/30 text-white" : ""}`}
                      >
                        {w.word}{" "}
                      </span>
                    ))
                  : "No speech in this range."}
              </p>
            </div>
          </div>

          <div className="card space-y-5 p-5">
            <h2 className="font-medium">Captions & export</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {CAPTION_STYLES.map((s) => (
                <button
                  key={s}
                  onClick={() => setCaptionStyle(s)}
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    captionStyle === s ? "border-brand-500 bg-brand-500/15 text-white" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  {CAPTION_STYLE_LABELS[s]}
                </button>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-4">
              <label>
                <span className="label">Highlight</span>
                <input type="color" className="h-9 w-full cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900" value={highlight} onChange={(e) => setHighlight(e.target.value.toUpperCase())} />
              </label>
              <label>
                <span className="label">Position</span>
                <select className="input" value={position} onChange={(e) => setPosition(e.target.value as "bottom" | "middle")}>
                  <option value="bottom">Lower third</option>
                  <option value="middle">Center</option>
                </select>
              </label>
              <label>
                <span className="label">Resolution</span>
                <select className="input" value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>
                  <option value="1080x1920">1080×1920</option>
                  <option value="720x1280">720×1280</option>
                </select>
              </label>
              <label>
                <span className="label">Watermark</span>
                <input
                  className="input"
                  maxLength={40}
                  placeholder="@yourhandle (optional)"
                  value={watermark}
                  onChange={(e) => setWatermark(e.target.value)}
                />
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <div>
                <span className="label">Include in this short</span>
                <IncludeToggles value={include} onChange={setInclude} brandKit={brandKit} />
                {!brandKit?.introAssetId && !brandKit?.outroAssetId && !brandKit?.musicAssetId && !brandKit?.logoAssetId && (
                  <Link href="/settings" className="mt-1 inline-block text-xs text-brand-400 hover:underline">
                    Set up an intro, outro, music or logo →
                  </Link>
                )}
                {(include.intro && brandKit?.introAssetId) || (include.outro && brandKit?.outroAssetId) ? (
                  <p className="mt-1 text-[11px] text-zinc-500">Intro/outro and music are added during the render (not shown in this preview).</p>
                ) : null}
              </div>
              <label>
                <span className="label">Zoomed-out bars</span>
                <select className="input" value={letterboxFill} onChange={(e) => setLetterboxFill(e.target.value as "blur" | "black")}>
                  <option value="blur">Blurred video</option>
                  <option value="black">Black</option>
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-primary" disabled={rendering || saving} onClick={startRender}>
                {rendering ? "Rendering…" : dirty ? "Save & render 9:16" : "Render 9:16 MP4"}
              </button>
              <span className="text-xs text-zinc-500">Shorts · Reels · TikTok ready (H.264/AAC, 9:16)</span>
            </div>

            {render && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span>
                    {STATUS_LABELS[render.status]} · {CAPTION_STYLE_LABELS[render.captionStyle]} · {render.resolution}
                  </span>
                  {rendering && <span className="tabular-nums text-zinc-400">{render.progressPercent}%</span>}
                </div>
                {rendering && (
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
                    <div className="h-full bg-brand-500 transition-all duration-700" style={{ width: `${render.progressPercent}%` }} />
                  </div>
                )}
                {render.status === "failed" && <p className="mt-2 text-sm text-red-400">{render.errorMessage}</p>}
                {render.status === "completed" && (
                  <button className="btn-primary mt-3" onClick={() => download(render)}>
                    Download MP4 {render.output && `(${formatBytes(render.output.fileSizeBytes)})`}
                  </button>
                )}
              </div>
            )}

            {renders.filter((r) => r.status === "completed" && r.id !== render?.id).length > 0 && (
              <div>
                <span className="label">Previous exports</span>
                <ul className="divide-y divide-zinc-800 text-sm">
                  {renders
                    .filter((r) => r.status === "completed" && r.id !== render?.id)
                    .map((r) => (
                      <li key={r.id} className="flex items-center justify-between py-2">
                        <span className="text-zinc-400">
                          {new Date(r.createdAt).toLocaleString()} · {CAPTION_STYLE_LABELS[r.captionStyle]} · {r.resolution}
                        </span>
                        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => download(r)}>
                          Download
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>

          <div className="card space-y-4 p-5">
            <h2 className="font-medium">Publish</h2>
            <PublishPanel
              clipId={clip.id}
              drafts={drafts}
              readyPlatforms={readyPlatforms}
              publications={clip.publications ?? []}
              disabledReason={
                clip.status === "edited" || clip.status === "candidate" || dirty
                  ? "Render the clip with your latest edits before publishing."
                  : undefined
              }
              onPublished={() => reloadClip()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ClipEditorPage() {
  return (
    <AppShell>
      <Editor />
    </AppShell>
  );
}
