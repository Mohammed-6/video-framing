import { Storage } from "@google-cloud/storage";
import { BlobStorage, SignedUrl, contentDisposition } from "./types";

/**
 * Google Cloud Storage driver using V4 signed URLs.
 *
 * On Cloud Run the runtime service account needs `roles/iam.serviceAccountTokenCreator`
 * on itself so the client library can sign via the IAM signBlob API, and the bucket
 * needs a CORS policy allowing PUT from the web origin (see infra/gcp/terraform).
 */
export class GcsStorage implements BlobStorage {
  readonly driver = "gcs" as const;
  private readonly storage = new Storage();

  constructor(private readonly bucketName: string) {}

  private file(key: string) {
    return this.storage.bucket(this.bucketName).file(key);
  }

  async createUploadUrl(
    key: string,
    opts: { contentType: string; maxBytes: number; ttlSeconds: number },
  ): Promise<SignedUrl> {
    const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);
    // x-goog-content-length-range makes GCS reject bodies larger than the declared size.
    const extensionHeaders = { "x-goog-content-length-range": `0,${opts.maxBytes}` };
    const [url] = await this.file(key).getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType: opts.contentType,
      extensionHeaders,
    });
    return { url, headers: { "Content-Type": opts.contentType, ...extensionHeaders }, expiresAt };
  }

  async createReadUrl(key: string, opts: { ttlSeconds: number; downloadFileName?: string }): Promise<SignedUrl> {
    const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);
    const [url] = await this.file(key).getSignedUrl({
      version: "v4",
      action: "read",
      expires: expiresAt,
      responseDisposition: opts.downloadFileName ? contentDisposition(opts.downloadFileName) : undefined,
    });
    return { url, headers: {}, expiresAt };
  }

  async delete(key: string) {
    await this.file(key).delete({ ignoreNotFound: true });
  }

  async stat(key: string) {
    try {
      const [meta] = await this.file(key).getMetadata();
      return { sizeBytes: Number(meta.size ?? 0), contentType: meta.contentType ?? undefined };
    } catch (err: any) {
      if (err?.code === 404) return null;
      throw err;
    }
  }
}
