export function formatTime(seconds: number, withMs = false): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const base = `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(sec).padStart(2, "0")}`;
  return withMs ? `${base}.${String(Math.floor((s % 1) * 10))}` : base;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return "–";
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** `datetime-local` input value for a Date, in local time. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "downloading",
  "validating",
  "extracting_audio",
  "transcribing",
  "selecting_clips",
]);
export const ACTIVE_RENDER_STATUSES = new Set(["queued", "rendering"]);
export const ACTIVE_PUBLISH_STATUSES = new Set(["queued", "publishing"]);

export const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  downloading: "Downloading",
  validating: "Validating",
  extracting_audio: "Extracting audio",
  transcribing: "Transcribing",
  selecting_clips: "Selecting clips",
  clips_ready: "Clips ready",
  rendering: "Rendering",
  completed: "Completed",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const PLATFORM_COLORS: Record<string, string> = {
  youtube: "bg-red-600",
  facebook: "bg-blue-600",
  instagram: "bg-gradient-to-br from-fuchsia-600 to-amber-500",
};
