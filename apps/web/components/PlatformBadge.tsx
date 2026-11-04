import { PLATFORM_LABELS, type Platform, type Publication } from "@clipforge/contracts";
import { PLATFORM_COLORS, STATUS_LABELS, formatDateTime } from "@/lib/format";

export function PlatformDot({ platform }: { platform: Platform }) {
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${PLATFORM_COLORS[platform]}`} />;
}

const STATUS_STYLE: Record<string, string> = {
  queued: "text-amber-300",
  publishing: "text-sky-300",
  published: "text-emerald-300",
  failed: "text-red-400",
  cancelled: "text-zinc-500",
};

/** One-line status for a post: platform · status (· link). */
export function PublicationBadge({ pub }: { pub: Publication }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <PlatformDot platform={pub.platform} />
      <span className="text-zinc-300">{PLATFORM_LABELS[pub.platform]}</span>
      <span className={STATUS_STYLE[pub.status]}>
        {STATUS_LABELS[pub.status]}
        {pub.status === "publishing" && ` ${pub.progressPercent}%`}
      </span>
      {pub.externalUrl && (
        <a href={pub.externalUrl} target="_blank" rel="noreferrer" className="text-brand-400 hover:underline">
          view ↗
        </a>
      )}
    </span>
  );
}
