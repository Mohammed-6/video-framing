import type { Config } from "../config";
import { GcsStorage } from "./gcs";
import { LocalStorage } from "./local";
import type { BlobStorage } from "./types";

export * from "./types";

export function createStorage(cfg: Config): BlobStorage {
  if (cfg.STORAGE_DRIVER === "gcs") return new GcsStorage(cfg.GCS_BUCKET!);
  return new LocalStorage(cfg.LOCAL_STORAGE_DIR, cfg.PUBLIC_API_URL, cfg.STORAGE_SIGNING_SECRET);
}

const UNSAFE_CHARS = /[^a-zA-Z0-9._-]+/g;

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "video";
  const cleaned = base.replace(UNSAFE_CHARS, "_").replace(/^\.+/, "").slice(-100);
  return cleaned || "video";
}

export const blobKeys = {
  source: (videoId: string, fileName: string) => `sources/${videoId}/${sanitizeFileName(fileName)}`,
};
