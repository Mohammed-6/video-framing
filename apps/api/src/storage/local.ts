import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import { HttpError } from "../http/errors";
import { BlobStorage, SignedUrl, contentDisposition } from "./types";

const KEY_RE = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Development-only storage driver that emulates signed URLs against a local
 * directory (shared with the media worker through a Docker volume).
 * URLs are HMAC-signed and expire, mirroring the GCS contract.
 */
export class LocalStorage implements BlobStorage {
  readonly driver = "local" as const;
  readonly root: string;

  constructor(
    root: string,
    private readonly publicBaseUrl: string,
    private readonly secret: string,
  ) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  resolve(key: string): string {
    if (!KEY_RE.test(key) || key.split("/").some((s) => s === ".." || s === "")) {
      throw new HttpError(400, "invalid_key", "Invalid blob key");
    }
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new HttpError(400, "invalid_key", "Invalid blob key");
    return full;
  }

  sign(parts: Record<string, string>): string {
    const canonical = Object.keys(parts)
      .sort()
      .map((k) => `${k}=${parts[k]}`)
      .join("&");
    return crypto.createHmac("sha256", this.secret).update(canonical).digest("hex");
  }

  verify(parts: Record<string, string>, sig: string): boolean {
    const expected = Buffer.from(this.sign(parts), "hex");
    const given = Buffer.from(sig, "hex");
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }

  private buildUrl(params: Record<string, string>): string {
    const sig = this.sign(params);
    const qs = new URLSearchParams({ ...params, sig });
    return `${this.publicBaseUrl}/api/v1/storage/local?${qs.toString()}`;
  }

  async createUploadUrl(key: string, opts: { contentType: string; maxBytes: number; ttlSeconds: number }) {
    this.resolve(key);
    const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);
    const params = {
      op: "put",
      key,
      ct: opts.contentType,
      max: String(opts.maxBytes),
      exp: String(Math.floor(expiresAt.getTime() / 1000)),
    };
    return { url: this.buildUrl(params), headers: { "Content-Type": opts.contentType }, expiresAt } satisfies SignedUrl;
  }

  async createReadUrl(key: string, opts: { ttlSeconds: number; downloadFileName?: string }) {
    this.resolve(key);
    const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);
    const params: Record<string, string> = { op: "get", key, exp: String(Math.floor(expiresAt.getTime() / 1000)) };
    if (opts.downloadFileName) params.dl = opts.downloadFileName;
    return { url: this.buildUrl(params), headers: {}, expiresAt } satisfies SignedUrl;
  }

  async delete(key: string) {
    await fs.promises.rm(this.resolve(key), { force: true });
  }

  async stat(key: string) {
    try {
      const st = await fs.promises.stat(this.resolve(key));
      return { sizeBytes: st.size };
    } catch {
      return null;
    }
  }
}

/** Routes backing LocalStorage signed URLs. Mounted only when STORAGE_DRIVER=local. */
export function localStorageRouter(storage: LocalStorage): Router {
  const router = Router();

  function checkSignature(query: Record<string, unknown>, op: "put" | "get") {
    const q = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const { sig, ...params } = q;
    if (!sig || params.op !== op || !params.key || !params.exp) {
      throw new HttpError(403, "invalid_signature", "Invalid signed URL");
    }
    if (!/^[0-9a-f]+$/.test(sig) || !storage.verify(params, sig)) {
      throw new HttpError(403, "invalid_signature", "Invalid signed URL");
    }
    if (Number(params.exp) * 1000 < Date.now()) throw new HttpError(403, "expired", "Signed URL expired");
    return params;
  }

  router.put("/", async (req, res) => {
    const params = checkSignature(req.query as Record<string, unknown>, "put");
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
    if (contentType !== params.ct) throw new HttpError(400, "content_type_mismatch", "Content-Type does not match");
    const max = Number(params.max);
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "too_large", "Upload too large");

    const target = storage.resolve(params.key!);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${crypto.randomUUID()}.part`;
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > max) req.destroy(new HttpError(413, "too_large", "Upload too large"));
    });
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      await fs.promises.rename(tmp, target);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
    res.status(200).end();
  });

  router.get("/", (req, res, next) => {
    const params = checkSignature(req.query as Record<string, unknown>, "get");
    const file = storage.resolve(params.key!);
    if (params.dl) res.setHeader("Content-Disposition", contentDisposition(params.dl));
    // sendFile handles Range requests, which the <video> element needs for seeking.
    res.sendFile(file, { dotfiles: "deny" }, (err) => {
      if (err && !res.headersSent) next(new HttpError(404, "not_found", "Blob not found"));
    });
  });

  return router;
}
