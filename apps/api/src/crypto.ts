/**
 * AES-256-GCM encryption for platform credentials stored in Postgres.
 * Format: "v1:" + base64(iv[12] | ciphertext | tag[16]) — the Python worker
 * (app/crypto.py) decrypts the same format with `cryptography`'s AESGCM.
 */
import crypto from "node:crypto";

export type Credentials = Record<string, string>;

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("credentials key must be 32 bytes");
  }

  encrypt(data: Credentials): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    return `v1:${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64")}`;
  }

  decrypt(value: string | null | undefined): Credentials {
    if (!value) return {};
    if (!value.startsWith("v1:")) throw new Error("unknown credentials format");
    const raw = Buffer.from(value.slice(3), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
  }
}
