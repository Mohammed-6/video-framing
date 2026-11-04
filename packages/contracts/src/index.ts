/**
 * Shared API contracts for ClipForge (API v1) — single-owner automation tool.
 *
 * The Node API validates requests with these schemas and the web app imports the
 * inferred types. The Python worker mirrors clip-plan / transcript / settings shapes
 * in apps/media-worker/app/models — keep them in sync when changing this file.
 */
import { z } from "zod";

export const API_PREFIX = "/api/v1";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
  "queued",
  "downloading",
  "validating",
  "extracting_audio",
  "transcribing",
  "selecting_clips",
  "clips_ready",
  "rendering",
  "completed",
  "failed",
  "cancelled",
] as const;
export const JobStatus = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatus>;

export const ACTIVE_ANALYSIS_STATUSES: readonly JobStatus[] = [
  "queued",
  "downloading",
  "validating",
  "extracting_audio",
  "transcribing",
  "selecting_clips",
];

export const SOURCE_VIDEO_STATUSES = ["pending", "pending_upload", "uploaded", "processing", "ready", "failed"] as const;
export type SourceVideoStatus = (typeof SOURCE_VIDEO_STATUSES)[number];

export const CLIP_STATUSES = ["candidate", "edited", "rendered", "published", "discarded"] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];

export const VIDEO_CONTENT_TYPES = ["video/mp4", "video/quicktime"] as const;
export const VideoContentType = z.enum(VIDEO_CONTENT_TYPES);

/** MVP renders 9:16 only. */
export const AspectRatio = z.enum(["9:16"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const RESOLUTIONS = ["1080x1920", "720x1280"] as const;
export const Resolution = z.enum(RESOLUTIONS);
export type Resolution = z.infer<typeof Resolution>;

export const CAPTION_STYLES = ["bold_pop", "karaoke", "minimal", "boxed", "none"] as const;
export const CaptionStyle = z.enum(CAPTION_STYLES);
export type CaptionStyle = z.infer<typeof CaptionStyle>;

export const CAPTION_STYLE_LABELS: Record<CaptionStyle, string> = {
  bold_pop: "Bold Pop",
  karaoke: "Karaoke",
  minimal: "Minimal",
  boxed: "Boxed",
  none: "No captions",
};

export const PLATFORMS = ["youtube", "facebook", "instagram"] as const;
export const Platform = z.enum(PLATFORMS);
export type Platform = z.infer<typeof Platform>;

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: "YouTube Shorts",
  facebook: "Facebook Reels",
  instagram: "Instagram Reels",
};

export const PUBLISH_STATUSES = ["queued", "publishing", "published", "failed", "cancelled"] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

const uuid = z.string().uuid();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected a #RRGGBB colour");

// ---------------------------------------------------------------------------
// Auth (single owner, password from APP_PASSWORD)
// ---------------------------------------------------------------------------

export const LoginRequest = z.object({ password: z.string().min(1).max(200) });
export type LoginRequest = z.infer<typeof LoginRequest>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const AnalysisDefaults = z
  .object({
    targetClipCount: z.number().int().min(1).max(15).default(5),
    minDurationSeconds: z.number().min(5).max(170).default(20),
    maxDurationSeconds: z.number().min(10).max(180).default(60),
    language: z
      .string()
      .regex(/^[a-z]{2,3}$/, "Use an ISO-639 language code, e.g. 'en'")
      .optional(),
  })
  .refine((v) => v.minDurationSeconds + 5 <= v.maxDurationSeconds, {
    message: "maxDurationSeconds must be at least 5s greater than minDurationSeconds",
    path: ["maxDurationSeconds"],
  });
export type AnalysisDefaults = z.infer<typeof AnalysisDefaults>;

export const BrandOptions = z.object({
  watermarkText: z.string().trim().max(40).optional(),
  primaryColor: hexColor.optional(),
  captionPosition: z.enum(["bottom", "middle"]).default("bottom"),
});
export type BrandOptions = z.infer<typeof BrandOptions>;

export const ReframeMode = z.enum(["auto", "fixed"]);
export type ReframeMode = z.infer<typeof ReframeMode>;

// ---------------------------------------------------------------------------
// Brand kit: intro/outro videos, background music, logo image
// ---------------------------------------------------------------------------

export const ASSET_KINDS = ["intro", "outro", "music", "logo"] as const;
export const AssetKind = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof AssetKind>;

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  intro: "Intro video",
  outro: "Outro video",
  music: "Background music",
  logo: "Logo image",
};

export const ASSET_CONTENT_TYPES: Record<AssetKind, readonly string[]> = {
  intro: ["video/mp4", "video/quicktime"],
  outro: ["video/mp4", "video/quicktime"],
  music: ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav", "audio/ogg"],
  logo: ["image/png", "image/webp", "image/jpeg"],
};

export const ASSET_MAX_BYTES: Record<AssetKind, number> = {
  intro: 300 * 1024 ** 2,
  outro: 300 * 1024 ** 2,
  music: 60 * 1024 ** 2,
  logo: 5 * 1024 ** 2,
};

export const CreateAssetUploadRequest = z
  .object({
    kind: AssetKind,
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().min(1).max(100),
    fileSizeBytes: z.number().int().positive(),
  })
  .refine((v) => ASSET_CONTENT_TYPES[v.kind].includes(v.contentType), {
    message: "Unsupported file type for this asset",
    path: ["contentType"],
  })
  .refine((v) => v.fileSizeBytes <= ASSET_MAX_BYTES[v.kind], { message: "File too large", path: ["fileSizeBytes"] });
export type CreateAssetUploadRequest = z.infer<typeof CreateAssetUploadRequest>;

export type BrandAsset = {
  id: string;
  kind: AssetKind;
  name: string;
  contentType: string;
  fileSizeBytes: number;
  status: "pending_upload" | "ready";
  createdAt: string;
};

export const LOGO_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type LogoPosition = (typeof LOGO_POSITIONS)[number];

const assetId = z.string().uuid().nullable().default(null);

export const BrandKit = z.object({
  introAssetId: assetId,
  outroAssetId: assetId,
  musicAssetId: assetId,
  /** Music level under speech (0..1 of full volume). */
  musicVolume: z.number().min(0).max(1).default(0.15),
  /** Dip the music automatically while someone is talking. */
  duckMusic: z.boolean().default(true),
  logoAssetId: assetId,
  logoPosition: z.enum(LOGO_POSITIONS).default("top-left"),
  /** Logo width as a fraction of the video width. */
  logoScale: z.number().min(0.05).max(0.5).default(0.18),
  logoOpacity: z.number().min(0.1).max(1).default(0.9),
});
export type BrandKit = z.infer<typeof BrandKit>;

/** Per-render on/off switches for brand-kit pieces (all on by default when configured). */
/** What goes into a render. Unticked = left out, even if the brand kit has one set up. */
export const BrandInclude = z.object({
  intro: z.boolean().default(true),
  outro: z.boolean().default(true),
  music: z.boolean().default(true),
  logo: z.boolean().default(true),
  captions: z.boolean().default(true),
});
export const INCLUDE_KEYS = ["intro", "outro", "music", "logo", "captions"] as const;
export type IncludeKey = (typeof INCLUDE_KEYS)[number];
export const INCLUDE_LABELS: Record<IncludeKey, string> = {
  intro: "Intro",
  outro: "Outro",
  music: "Music",
  logo: "Logo",
  captions: "Captions",
};
export type BrandInclude = z.infer<typeof BrandInclude>;

export const RenderDefaults = z.object({
  brandKit: BrandKit.default({}),
  /** Default on/off for each piece; every render (auto or manual) starts from this. */
  include: BrandInclude.default({}),
  /** auto = follow the active speaker (face tracking); center = fixed centre crop. */
  reframe: z.enum(["auto", "center"]).default("auto"),
  /** Several people on screen: zoom out (letterboxing if needed) to show everyone, or follow the speaker. */
  multiFace: z.enum(["group", "speaker"]).default("group"),
  /**
   * With multiFace=group: if any part of the clip needs to zoom out, keep that zoomed-out layout
   * (and its blurred bars) for the whole clip instead of switching between tight and wide.
   */
  steadyZoom: z.boolean().default(true),
  /** What fills the space above/below a zoomed-out frame. */
  letterboxFill: z.enum(["blur", "black"]).default("blur"),
  captionStyle: CaptionStyle.default("bold_pop"),
  resolution: Resolution.default("1080x1920"),
  brand: BrandOptions.default({ captionPosition: "bottom" }),
});
export type RenderDefaults = z.infer<typeof RenderDefaults>;

export const AppSettings = z.object({
  analysis: AnalysisDefaults.default({}),
  render: RenderDefaults.default({}),
  /** Render every selected clip automatically so it lands in the review queue. */
  autoRender: z.boolean().default(true),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const UpdateSettingsRequest = AppSettings;

// ---------------------------------------------------------------------------
// YouTube discovery & import
// ---------------------------------------------------------------------------

export const YoutubeSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  pageToken: z.string().max(200).optional(),
  order: z.enum(["relevance", "date", "viewCount", "rating"]).default("relevance"),
  videoDuration: z.enum(["any", "medium", "long"]).default("long"),
  videoLicense: z.enum(["any", "creativeCommon"]).default("any"),
  publishedAfter: z.string().datetime().optional(),
  channelId: z.string().max(64).optional(),
});
export type YoutubeSearchQuery = z.infer<typeof YoutubeSearchQuery>;

export type YoutubeVideo = {
  videoId: string;
  url: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  license: "youtube" | "creativeCommon" | string;
  /** Present when this video was already imported. */
  imported: { sourceVideoId: string; status: SourceVideoStatus } | null;
};

/** The app's own estimate of today's YouTube Data API quota use (Google resets it at midnight Pacific). */
export type YoutubeQuota = {
  usedUnits: number;
  dailyLimit: number;
  /** Full searches (search + details = 101 units) that still fit today. */
  searchesLeft: number;
  exhausted: boolean;
  resetsAt: string;
};

export type YoutubeSearchResponse = {
  items: YoutubeVideo[];
  nextPageToken: string | null;
  totalResults: number;
  /** Served from the app's cache: cost no quota. */
  cached: boolean;
  quota: YoutubeQuota;
};

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Accepts bare IDs or any youtube.com / youtu.be URL. */
export function parseYoutubeId(input: string): string | null {
  const s = input.trim();
  if (YOUTUBE_ID.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return YOUTUBE_ID.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null;
    if (host === "youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v && YOUTUBE_ID.test(v)) return v;
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/);
      return m ? m[1]! : null;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

export const ImportYoutubeRequest = z.object({
  /** Video IDs or URLs. */
  videos: z.array(z.string().min(1).max(300)).min(1).max(25),
  /** Overrides for this import; defaults come from settings. */
  analysis: z
    .object({
      targetClipCount: z.number().int().min(1).max(15).optional(),
      minDurationSeconds: z.number().min(5).max(170).optional(),
      maxDurationSeconds: z.number().min(10).max(180).optional(),
      language: z.string().regex(/^[a-z]{2,3}$/).optional(),
    })
    .default({}),
});
export type ImportYoutubeRequest = z.infer<typeof ImportYoutubeRequest>;

export type ImportYoutubeResponse = {
  queued: { videoId: string; sourceVideoId: string; jobId: string }[];
  skipped: { input: string; reason: string }[];
};

// ---------------------------------------------------------------------------
// Uploads (local files are a secondary source)
// ---------------------------------------------------------------------------

export const CreateUploadRequest = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: VideoContentType,
  fileSizeBytes: z.number().int().positive(),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export type CreateUploadResponse = {
  sourceVideoId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  blobKey: string;
  expiresAt: string;
};

export const CompleteUploadRequest = z.object({ sourceVideoId: uuid, blobKey: z.string().min(1) });
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequest>;

// ---------------------------------------------------------------------------
// Source videos / jobs
// ---------------------------------------------------------------------------

export type SourceVideo = {
  id: string;
  origin: "youtube" | "upload";
  youtubeVideoId: string | null;
  sourceUrl: string | null;
  title: string;
  channelTitle: string | null;
  license: string | null;
  thumbnailUrl: string | null;
  fileSizeBytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  status: SourceVideoStatus;
  createdAt: string;
  latestJob?: Job | null;
  clipCounts?: { total: number; rendered: number; published: number };
};

export const CreateAnalysisRequest = z.object({
  targetClipCount: z.number().int().min(1).max(15).optional(),
  minDurationSeconds: z.number().min(5).max(170).optional(),
  maxDurationSeconds: z.number().min(10).max(180).optional(),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
});
export type CreateAnalysisRequest = z.infer<typeof CreateAnalysisRequest>;

export type Job = {
  id: string;
  sourceVideoId: string;
  jobType: "analysis";
  status: JobStatus;
  stage: string | null;
  progressPercent: number;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type JobAccepted = { jobId: string; status: JobStatus; statusUrl: string };
export type PlaybackUrl = { url: string; expiresAt: string };

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export const TranscriptWord = z.object({
  start: z.number(),
  end: z.number(),
  word: z.string(),
  probability: z.number().optional(),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const TranscriptSegment = z.object({
  id: z.number().int(),
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(TranscriptWord).default([]),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export const ClipPlanItem = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  title: z.string().min(1).max(100),
  hook: z.string().max(300),
  reason: z.string().max(500),
  /** Ranking heuristic in [0,1] — not a virality prediction. */
  score: z.number().min(0).max(1),
});
export const ClipPlan = z.object({ clips: z.array(ClipPlanItem) });
export type ClipPlan = z.infer<typeof ClipPlan>;

export type Clip = {
  id: string;
  sourceVideoId: string;
  startSeconds: number;
  endSeconds: number;
  title: string;
  hook: string | null;
  selectionReason: string | null;
  score: number | null;
  cropCenterX: number;
  /** auto = crop follows the active speaker; fixed = static crop at cropCenterX. */
  reframeMode: ReframeMode;
  /** Fixed framing zoom-out: 0 = fill 9:16, 1 = whole scene letterboxed. */
  cropZoom: number;
  status: ClipStatus;
  createdAt: string;
  updatedAt: string;
  latestRender?: RenderJob | null;
  publications?: Publication[];
};

export const UpdateClipRequest = z
  .object({
    startSeconds: z.number().nonnegative().optional(),
    endSeconds: z.number().positive().optional(),
    title: z.string().trim().min(1).max(100).optional(),
    hook: z.string().trim().max(300).optional(),
    cropCenterX: z.number().min(0).max(1).optional(),
    reframeMode: ReframeMode.optional(),
    cropZoom: z.number().min(0).max(1).optional(),
    status: z.enum(["candidate", "discarded"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });
export type UpdateClipRequest = z.infer<typeof UpdateClipRequest>;

export type ClipDetail = Clip & {
  sourceVideo: SourceVideo;
  transcriptSegments: TranscriptSegment[];
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const RenderClipRequest = z.object({
  aspectRatio: AspectRatio.default("9:16"),
  captionStyle: CaptionStyle.optional(),
  resolution: Resolution.optional(),
  brand: BrandOptions.optional(),
  multiFace: z.enum(["group", "speaker"]).optional(),
  steadyZoom: z.boolean().optional(),
  letterboxFill: z.enum(["blur", "black"]).optional(),
  include: BrandInclude.partial().optional(),
});
export type RenderClipRequest = z.infer<typeof RenderClipRequest>;

export type RenderJob = {
  id: string;
  clipId: string;
  aspectRatio: AspectRatio;
  captionStyle: CaptionStyle;
  resolution: Resolution;
  status: JobStatus;
  progressPercent: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  output: ClipOutput | null;
  /** Camera path used for this render: [[t from clip start, centre x 0..1, window width 0..1], ...]. */
  reframeTrack: number[][] | null;
  /** What this render actually contains (null for renders made before this was recorded). */
  included: Record<IncludeKey, boolean> | null;
};

export type ClipOutput = {
  id: string;
  fileSizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
};

export type DownloadUrl = { url: string; fileName: string; expiresAt: string };

// ---------------------------------------------------------------------------
// Platforms & publishing
// ---------------------------------------------------------------------------

export type PlatformAccount = {
  platform: Platform;
  label: string;
  enabled: boolean;
  displayName: string | null;
  config: Record<string, unknown>;
  /** Which credential fields are stored (values are never returned). */
  credentialFields: string[];
  connected: boolean;
  captionTemplate: string;
  hashtags: string;
  connectedAt: string | null;
};

export const UpdatePlatformRequest = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.union([z.string(), z.boolean(), z.number()])).optional(),
  /** Merged into stored credentials; an empty string removes a field. */
  credentials: z.record(z.string().max(4000)).optional(),
  captionTemplate: z.string().max(2200).optional(),
  hashtags: z.string().max(500).optional(),
});
export type UpdatePlatformRequest = z.infer<typeof UpdatePlatformRequest>;

export const DEFAULT_CAPTION_TEMPLATE =
  "{hook}\n\n{hashtags}\n\nCredit: \"{source_title}\" by {source_channel} — {source_url}";

/** Placeholders available in caption templates. */
export const TEMPLATE_PLACEHOLDERS = [
  "{title}",
  "{hook}",
  "{hashtags}",
  "{source_title}",
  "{source_channel}",
  "{source_url}",
] as const;

export const PLATFORM_LIMITS: Record<Platform, { title: number; description: number; maxHashtags: number }> = {
  youtube: { title: 100, description: 5000, maxHashtags: 15 },
  facebook: { title: 255, description: 2200, maxHashtags: 30 },
  instagram: { title: 100, description: 2200, maxHashtags: 30 },
};

export function normalizeHashtags(raw: string, max = 30): string {
  const tags = raw
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean);
  return [...new Set(tags)].slice(0, max).map((t) => `#${t}`).join(" ");
}

export type TemplateContext = {
  title: string;
  hook: string | null;
  hashtags: string;
  sourceTitle: string | null;
  sourceChannel: string | null;
  sourceUrl: string | null;
};

/** Fill a caption template; a line is dropped if any placeholder on it is empty (no dangling "by  —"). */
export function renderCaptionTemplate(template: string, platform: Platform, ctx: TemplateContext): string {
  const limits = PLATFORM_LIMITS[platform];
  const values: Record<string, string> = {
    "{title}": ctx.title,
    "{hook}": ctx.hook ?? "",
    "{hashtags}": normalizeHashtags(ctx.hashtags, limits.maxHashtags),
    "{source_title}": ctx.sourceTitle ?? "",
    "{source_channel}": ctx.sourceChannel ?? "",
    "{source_url}": ctx.sourceUrl ?? "",
  };
  const lines = template.split("\n").flatMap((line) => {
    const used = Object.keys(values).filter((k) => line.includes(k));
    if (used.some((k) => !values[k])) return [];
    return [Object.entries(values).reduce((acc, [k, v]) => acc.split(k).join(v), line)];
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limits.description);
}

export function platformTitle(platform: Platform, title: string): string {
  let t = title.trim();
  // YouTube classifies vertical videos <= 3 min as Shorts; the tag helps discovery.
  if (platform === "youtube" && !/#shorts/i.test(t) && t.length + 8 <= PLATFORM_LIMITS.youtube.title) t += " #Shorts";
  return t.slice(0, PLATFORM_LIMITS[platform].title);
}

export const PublishClipRequest = z.object({
  targets: z
    .array(
      z.object({
        platform: Platform,
        title: z.string().trim().min(1).max(100).optional(),
        description: z.string().max(2200).optional(),
      }),
    )
    .min(1)
    .max(3),
});
export type PublishClipRequest = z.infer<typeof PublishClipRequest>;

export type Publication = {
  id: string;
  clipId: string;
  renderJobId: string;
  platform: Platform;
  title: string;
  description: string;
  status: PublishStatus;
  progressPercent: number;
  externalId: string | null;
  externalUrl: string | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  completedAt: string | null;
  clipTitle?: string;
  sourceVideoTitle?: string;
};



export type PublishPreview = {
  platform: Platform;
  title: string;
  description: string;
};

export type ReviewItem = Clip & {
  sourceVideo: Pick<SourceVideo, "id" | "title" | "channelTitle" | "sourceUrl" | "thumbnailUrl">;
  latestRender: RenderJob;
  /** Title/description rendered from each enabled platform's template. */
  drafts: PublishPreview[];
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiError = { error: { code: string; message: string; details?: unknown } };
