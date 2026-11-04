import { CLIP_LIMITS } from "@clipforge/config";

export type BoundsCheck = { ok: true; start: number; end: number } | { ok: false; message: string };

/**
 * Validates user-edited clip boundaries against the source video and product limits.
 * Times are rounded to milliseconds so float noise from the UI doesn't accumulate.
 */
export function validateClipBounds(
  start: number,
  end: number,
  sourceDurationSeconds: number | null,
  limits: { minSeconds: number; maxSeconds: number } = CLIP_LIMITS,
): BoundsCheck {
  const s = Math.round(start * 1000) / 1000;
  const e = Math.round(end * 1000) / 1000;
  if (!Number.isFinite(s) || !Number.isFinite(e)) return { ok: false, message: "Clip bounds must be numbers" };
  if (s < 0) return { ok: false, message: "Clip cannot start before 0s" };
  if (e <= s) return { ok: false, message: "Clip end must be after its start" };
  if (sourceDurationSeconds != null && e > sourceDurationSeconds + 0.05) {
    return { ok: false, message: `Clip cannot end after the source video (${sourceDurationSeconds.toFixed(2)}s)` };
  }
  const length = e - s;
  if (length < limits.minSeconds) return { ok: false, message: `Clips must be at least ${limits.minSeconds}s long` };
  if (length > limits.maxSeconds) return { ok: false, message: `Clips can be at most ${limits.maxSeconds}s long` };
  return { ok: true, start: s, end: sourceDurationSeconds != null ? Math.min(e, sourceDurationSeconds) : e };
}
