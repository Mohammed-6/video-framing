import type {
  AppSettings,
  BrandAsset,
  CreateAssetUploadRequest,
  Clip,
  ClipDetail,
  CreateAnalysisRequest,
  CreateUploadRequest,
  CreateUploadResponse,
  DownloadUrl,
  ImportYoutubeRequest,
  ImportYoutubeResponse,
  Job,
  JobAccepted,
  PlaybackUrl,
  Platform,
  PlatformAccount,
  Publication,
  PublishClipRequest,
  PublishPreview,
  RenderClipRequest,
  RenderJob,
  ReviewItem,
  SourceVideo,
  UpdateClipRequest,
  UpdatePlatformRequest,
  YoutubeQuota,
  YoutubeSearchQuery,
  YoutubeSearchResponse,
  YoutubeVideo,
} from "@clipforge/contracts";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/")) {
      window.location.href = "/login";
    }
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

function qs(params: Record<string, string | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  return s.toString();
}

export type SettingsResponse = {
  settings: AppSettings;
  environment: { youtubeSearchEnabled: boolean; googleOAuthFromEnv: boolean; storageDriver: string };
};

export type ReviewResponse = {
  items: ReviewItem[];
  pending: { rendering: number; analyzing: number };
  readyPlatforms: Platform[];
};

export const api = {
  login: (password: string) => request<{ ok: true }>("POST", "/auth/login", { password }),
  logout: () => request<void>("POST", "/auth/logout"),
  me: () => request<{ ok: true; youtubeSearchEnabled: boolean }>("GET", "/auth/me"),

  searchYoutube: (q: Partial<YoutubeSearchQuery> & { q: string }) =>
    request<YoutubeSearchResponse>("GET", `/youtube/search?${qs(q as Record<string, string | undefined>)}`),
  youtubeQuota: () => request<YoutubeQuota>("GET", "/youtube/quota"),
  lookupYoutube: (ids: string[]) => request<{ items: YoutubeVideo[] }>("GET", `/youtube/videos?${qs({ ids: ids.join(",") })}`),
  importYoutube: (body: Partial<ImportYoutubeRequest> & { videos: string[] }) =>
    request<ImportYoutubeResponse>("POST", "/youtube/import", body),

  createUpload: (body: CreateUploadRequest) => request<CreateUploadResponse>("POST", "/uploads", body),
  completeUpload: (id: string, blobKey: string) =>
    request<SourceVideo>("POST", `/uploads/${id}/complete`, { sourceVideoId: id, blobKey }),

  listVideos: () => request<{ videos: SourceVideo[] }>("GET", "/videos"),
  getVideo: (id: string) => request<SourceVideo>("GET", `/videos/${id}`),
  deleteVideo: (id: string) => request<void>("DELETE", `/videos/${id}`),
  analyze: (id: string, body: CreateAnalysisRequest = {}) => request<JobAccepted>("POST", `/videos/${id}/analyze`, body),
  listClips: (videoId: string) => request<{ clips: Clip[] }>("GET", `/videos/${videoId}/clips`),
  playback: (videoId: string) => request<PlaybackUrl>("GET", `/videos/${videoId}/playback`),

  getJob: (id: string) => request<Job>("GET", `/jobs/${id}`),
  cancelJob: (id: string) => request<Job>("POST", `/jobs/${id}/cancel`),

  getClip: (id: string) => request<ClipDetail>("GET", `/clips/${id}`),
  updateClip: (id: string, body: UpdateClipRequest) => request<Clip>("PATCH", `/clips/${id}`, body),
  renderClip: (id: string, body: Partial<RenderClipRequest> = {}) =>
    request<RenderJob & { statusUrl: string }>("POST", `/clips/${id}/render`, body),
  listRenders: (clipId: string) => request<{ renders: RenderJob[] }>("GET", `/clips/${clipId}/renders`),
  drafts: (clipId: string) => request<{ drafts: PublishPreview[] }>("GET", `/clips/${clipId}/drafts`),
  publishClip: (clipId: string, body: PublishClipRequest) =>
    request<{ publications: Publication[] }>("POST", `/clips/${clipId}/publish`, body),

  getRender: (id: string) => request<RenderJob>("GET", `/renders/${id}`),
  renderPlayback: (id: string) => request<PlaybackUrl>("GET", `/renders/${id}/playback`),
  downloadUrl: (id: string) => request<DownloadUrl>("GET", `/renders/${id}/download`),

  review: () => request<ReviewResponse>("GET", "/review"),
  publications: (status?: string) => request<{ publications: Publication[] }>("GET", `/publications?${qs({ status })}`),
  cancelPublication: (id: string) => request<Publication>("POST", `/publications/${id}/cancel`),
  retryPublication: (id: string) => request<Publication>("POST", `/publications/${id}/retry`),

  platforms: () => request<{ platforms: PlatformAccount[]; youtubeRedirectUri: string }>("GET", "/platforms"),
  updatePlatform: (p: Platform, body: UpdatePlatformRequest) => request<PlatformAccount>("PATCH", `/platforms/${p}`, body),
  testPlatform: (p: Platform) => request<PlatformAccount>("POST", `/platforms/${p}/test`),
  disconnectPlatform: (p: Platform) => request<PlatformAccount>("POST", `/platforms/${p}/disconnect`),
  youtubeOauthStart: () => request<{ url: string }>("GET", "/platforms/youtube/oauth/start"),

  assets: () => request<{ assets: BrandAsset[] }>("GET", "/assets"),
  createAssetUpload: (body: CreateAssetUploadRequest) => request<CreateUploadResponse>("POST", "/assets", body),
  completeAsset: (id: string) => request<BrandAsset>("POST", `/assets/${id}/complete`),
  assetUrl: (id: string) => request<PlaybackUrl>("GET", `/assets/${id}/url`),
  deleteAsset: (id: string) => request<void>("DELETE", `/assets/${id}`),

  settings: () => request<SettingsResponse>("GET", "/settings"),
  saveSettings: (s: AppSettings) => request<{ settings: AppSettings }>("PUT", "/settings", s),
};

export function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong";
}

/** PUT a file straight to the signed storage URL (XHR for upload progress). */
export function uploadToSignedUrl(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

export function startDownload(url: string, fileName: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
