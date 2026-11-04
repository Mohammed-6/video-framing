"use client";

import type { CaptionStyle, TranscriptWord } from "@clipforge/contracts";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { PREVIEW_THEMES, pageAt, paginate } from "@/lib/captions";
import { formatTime } from "@/lib/format";

type Props = {
  src: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  start: number;
  end: number;
  cropCenterX: number;
  /** Fixed framing zoom-out: 0 = fill 9:16, 1 = whole scene (letterboxed). */
  cropZoom?: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  words: TranscriptWord[];
  captionStyle: CaptionStyle;
  highlightColor?: string;
  captionPosition: "bottom" | "middle";
  watermark?: string;
  /** Camera path from the last render: [[t from clip start, centre x, window width?], ...]. */
  track?: number[][] | null;
  /** What fills the bars when the frame is zoomed out past 9:16. */
  letterboxFill?: "blur" | "black";
  logo?: { url: string; position: string; scale: number; opacity: number } | null;
  onTime?: (t: number) => void;
};

/** Interpolated [centre x, window width or null] at clip time t. Widths change by cut, not by zoom. */
function trackAt(track: number[][], t: number): [number, number | null] {
  const at = (i: number): [number, number | null] => [track[i]![1]!, track[i]![2] ?? null];
  if (t <= track[0]![0]!) return at(0);
  for (let i = 0; i < track.length - 1; i++) {
    const [t0, x0, w0] = track[i]!;
    const [t1, x1] = track[i + 1]!;
    if (t >= t0! && t < t1!) {
      const x = t1 === t0 ? x1! : x0! + ((x1! - x0!) * (t - t0!)) / (t1! - t0!);
      return [x, w0 ?? null];
    }
  }
  return at(track.length - 1);
}

/**
 * CSS box for the video inside the 9:16 frame so it shows exactly the renderer's window:
 * window width maps to the frame width; zoomed-out windows are centred vertically (letterbox).
 */
function videoBox(cx: number, winW: number | null, srcW: number | null, srcH: number | null) {
  if (!srcW || !srcH) return { left: "0%", top: "0%", width: "100%", height: "100%" };
  const tight = Math.min(1, (srcH * 9) / 16 / srcW);
  const w = Math.min(1, Math.max(tight, winW ?? tight));
  const left = Math.min(Math.max(cx - w / 2, 0), 1 - w); // window left edge, fraction of source width
  const widthPct = 100 / w; // video width relative to the frame
  const heightPct = (widthPct * (srcH / srcW) * 16) / 9; // relative to the frame height
  return {
    left: `${-left * widthPct}%`,
    top: `${(100 - heightPct) / 2}%`,
    width: `${widthPct}%`,
    height: `${heightPct}%`,
  };
}

/**
 * Previews a clip as it will be exported: 9:16 crop, styled captions and watermark.
 * Playback is bounded to [start, end].
 */
export function ClipPlayer(props: Props) {
  const { videoRef, start, end } = props;
  const [t, setT] = useState(start);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  const bounds = useRef({ start, end });
  bounds.current = { start, end };
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Latest framing for the blurred-fill canvas (read inside the animation loop).
  const fillRef = useRef<{ on: boolean; cx: number }>({ on: false, cx: 0.5 });

  // Smooth time updates while playing (timeupdate only fires ~4x/s, too coarse for word highlights).
  useEffect(() => {
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        if (v.currentTime >= bounds.current.end) {
          v.pause();
          v.currentTime = bounds.current.end;
        }
        setT(v.currentTime);
        props.onTime?.(v.currentTime);
        // Blurred fill: draw a 9:16 cover crop of the current frame; CSS blurs it.
        const c = canvasRef.current;
        if (c && fillRef.current.on && v.videoWidth && v.readyState >= 2) {
          const ctx = c.getContext("2d");
          const sw = Math.min(v.videoWidth, (v.videoHeight * 9) / 16);
          const sx = Math.min(Math.max(fillRef.current.cx * v.videoWidth - sw / 2, 0), v.videoWidth - sw);
          ctx?.drawImage(v, sx, 0, sw, v.videoHeight, 0, 0, c.width, c.height);
        }
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Jump to the new start when the user moves the in-point.
  useEffect(() => {
    const v = videoRef.current;
    if (v && (v.currentTime < start || v.currentTime > end)) v.currentTime = start;
  }, [start, end, videoRef]);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= end - 0.05 || v.currentTime < start) v.currentTime = start;
      void v.play();
    } else v.pause();
  }

  const theme = props.captionStyle === "none" ? null : PREVIEW_THEMES[props.captionStyle];
  const pages = useMemo(
    () => (theme ? paginate(props.words, theme.maxWords, theme.maxChars) : []),
    [props.words, theme],
  );
  const page = theme ? pageAt(pages, t) : null;
  const highlight = props.highlightColor || theme?.highlight || "#FFFFFF";
  const tightW =
    props.sourceWidth && props.sourceHeight ? Math.min(1, (props.sourceHeight * 9) / 16 / props.sourceWidth) : 1;
  const [centerX, trackW] = props.track?.length ? trackAt(props.track, t - start) : [props.cropCenterX, null];
  const winW = trackW ?? tightW + (1 - tightW) * (props.cropZoom ?? 0);
  const box = videoBox(centerX, winW, props.sourceWidth, props.sourceHeight);
  const letterboxed = winW > tightW + 1e-3;
  fillRef.current = { on: letterboxed && (props.letterboxFill ?? "blur") === "blur", cx: centerX };
  const logo = props.logo;
  const logoStyle: React.CSSProperties | null = logo
    ? {
        width: `${logo.scale * 100}%`,
        opacity: logo.opacity,
        ...(logo.position.endsWith("left") ? { left: "5%" } : { right: "5%" }),
        ...(logo.position.startsWith("top") ? { top: "4%" } : { bottom: "6%" }),
      }
    : null;
  const progress = Math.min(1, Math.max(0, (t - start) / Math.max(0.01, end - start)));

  return (
    <div className="flex flex-col items-center">
      <div
        className="relative aspect-[9/16] w-full max-w-[340px] overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-zinc-800"
        style={{ containerType: "inline-size" }}
        onClick={togglePlay}
      >
        <canvas
          ref={canvasRef}
          width={90}
          height={160}
          className={`absolute inset-0 h-full w-full scale-110 ${fillRef.current.on ? "" : "hidden"}`}
          style={{ filter: "blur(10px) brightness(0.9) saturate(0.85)" }}
        />
        <video
          ref={videoRef}
          src={props.src}
          className="absolute max-w-none"
          style={box}
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => (e.currentTarget.currentTime = start)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />

        {logo && logoStyle && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo.url} alt="" className="pointer-events-none absolute h-auto" style={logoStyle} />
        )}

        {props.watermark && (
          <div
            className="absolute right-[5%] top-[4%] font-bold text-white/75"
            style={{ fontSize: "3.7cqw", WebkitTextStroke: "0.15cqw rgba(0,0,0,0.5)", paintOrder: "stroke fill" }}
          >
            {props.watermark}
          </div>
        )}

        {theme && page && (
          <div
            className={`pointer-events-none absolute inset-x-[8%] text-center leading-tight ${
              props.captionPosition === "bottom" ? "bottom-[22%]" : "top-1/2 -translate-y-1/2"
            }`}
          >
            <CaptionLine style={props.captionStyle} words={page} t={t} highlight={highlight} uppercase={theme.uppercase} />
          </div>
        )}

        {!playing && (
          <div className="absolute inset-0 grid place-items-center bg-black/20">
            <span className="grid h-14 w-14 place-items-center rounded-full bg-white/90 text-xl text-black">▶</span>
          </div>
        )}
      </div>

      <div className="mt-3 w-full max-w-[340px]">
        <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full bg-brand-500" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-xs tabular-nums text-zinc-400">
          <span>{formatTime(Math.max(0, t - start), true)}</span>
          <span>{formatTime(end - start, true)}</span>
        </div>
      </div>
    </div>
  );
}

function CaptionLine({
  style,
  words,
  t,
  highlight,
  uppercase,
}: {
  style: CaptionStyle;
  words: TranscriptWord[];
  t: number;
  highlight: string;
  uppercase: boolean;
}) {
  const base: React.CSSProperties = {
    color: "#fff",
    fontWeight: style === "minimal" ? 500 : 800,
    fontSize: style === "bold_pop" ? "8.9cqw" : style === "karaoke" ? "7.8cqw" : style === "boxed" ? "6.5cqw" : "6.1cqw",
    textTransform: uppercase ? "uppercase" : undefined,
    ...(style === "minimal"
      ? { textShadow: "0 0.4cqw 1.2cqw rgba(0,0,0,0.9)" }
      : style === "boxed"
        ? { background: "rgba(0,0,0,0.62)", padding: "0.6cqw 2cqw", borderRadius: "1cqw", boxDecorationBreak: "clone" }
        : { WebkitTextStroke: "1.1cqw #000", paintOrder: "stroke fill" }),
  };
  return (
    <span style={base}>
      {words.map((w, i) => {
        const active = t >= w.start && (i === words.length - 1 || t < words[i + 1]!.start);
        const spoken = t >= w.end;
        let color: string | undefined;
        if (style === "karaoke") color = spoken || active ? highlight : undefined;
        else if ((style === "bold_pop" || style === "boxed") && active) color = highlight;
        return (
          <span
            key={`${w.start}-${i}`}
            style={{
              color,
              display: "inline-block",
              transform: style === "bold_pop" && active ? "scale(1.12)" : undefined,
              transition: "transform 80ms",
              marginRight: "0.25em",
            }}
          >
            {w.word}
          </span>
        );
      })}
    </span>
  );
}
