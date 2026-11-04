/**
 * Client-side caption preview logic. Mirrors the pagination rules in
 * apps/media-worker/app/pipeline/captions.py so the editor preview matches the render.
 */
import type { CaptionStyle, TranscriptSegment, TranscriptWord } from "@clipforge/contracts";

export type PreviewTheme = {
  maxWords: number;
  maxChars: number;
  uppercase: boolean;
  mode: "word_highlight" | "karaoke" | "static";
  highlight: string;
};

export const PREVIEW_THEMES: Record<Exclude<CaptionStyle, "none">, PreviewTheme> = {
  bold_pop: { maxWords: 3, maxChars: 18, uppercase: true, mode: "word_highlight", highlight: "#FFE14D" },
  karaoke: { maxWords: 5, maxChars: 28, uppercase: false, mode: "karaoke", highlight: "#3DF2A6" },
  minimal: { maxWords: 8, maxChars: 42, uppercase: false, mode: "static", highlight: "#FFFFFF" },
  boxed: { maxWords: 5, maxChars: 30, uppercase: false, mode: "word_highlight", highlight: "#FFE14D" },
};

/** Words of the given segments, falling back to evenly distributed timings when missing. */
export function flattenWords(segments: TranscriptSegment[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const seg of segments) {
    if (seg.words?.length) {
      out.push(...seg.words);
      continue;
    }
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
    let t = seg.start;
    for (const tok of tokens) {
      const d = ((seg.end - seg.start) * tok.length) / total;
      out.push({ start: t, end: t + d, word: tok });
      t += d;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function paginate(words: TranscriptWord[], maxWords: number, maxChars: number, maxGap = 0.7): TranscriptWord[][] {
  const pages: TranscriptWord[][] = [];
  let cur: TranscriptWord[] = [];
  for (const w of words) {
    const last = cur[cur.length - 1];
    if (last) {
      const chars = cur.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length;
      const gap = w.start - last.end;
      const sentenceEnd = /[.?!]$/.test(last.word);
      if (cur.length >= maxWords || chars > maxChars || gap > maxGap || sentenceEnd) {
        pages.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/** The page visible at time `t` (absolute seconds), holding briefly after the last word like the renderer. */
export function pageAt(pages: TranscriptWord[][], t: number): TranscriptWord[] | null {
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const start = page[0]!.start;
    const nextStart = pages[i + 1]?.[0]?.start ?? Infinity;
    const lastEnd = page[page.length - 1]!.end;
    const end = nextStart - lastEnd < 0.4 ? nextStart : Math.min(lastEnd + 0.3, nextStart);
    if (t >= start && t < end) return page;
  }
  return null;
}
