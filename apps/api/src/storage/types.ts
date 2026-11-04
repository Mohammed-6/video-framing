export type SignedUrl = { url: string; headers: Record<string, string>; expiresAt: Date };

/**
 * Blob storage abstraction. Large media never flows through the API process:
 * clients PUT/GET directly against short-lived signed URLs.
 */
export interface BlobStorage {
  readonly driver: "gcs" | "local";
  createUploadUrl(key: string, opts: { contentType: string; maxBytes: number; ttlSeconds: number }): Promise<SignedUrl>;
  createReadUrl(key: string, opts: { ttlSeconds: number; downloadFileName?: string }): Promise<SignedUrl>;
  stat(key: string): Promise<{ sizeBytes: number; contentType?: string } | null>;
  delete(key: string): Promise<void>;
}

/** RFC 6266-safe Content-Disposition value. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
