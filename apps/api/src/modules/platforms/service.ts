import {
  DEFAULT_CAPTION_TEMPLATE,
  PLATFORM_LABELS,
  platformTitle,
  renderCaptionTemplate,
  type Platform,
  type PlatformAccount,
  type PublishPreview,
} from "@clipforge/contracts";
import type { Credentials, CredentialCipher } from "../../crypto";
import type { Db } from "../../db/pool";
import { HttpError } from "../../http/errors";

export const DEFAULT_GRAPH_VERSION = "v23.0";
export const DEFAULT_HASHTAGS = "#shorts #viral";

export type PlatformRow = {
  platform: Platform;
  enabled: boolean;
  display_name: string | null;
  config: Record<string, unknown>;
  credentials: string | null;
  caption_template: string | null;
  hashtags: string | null;
  connected_at: Date | null;
};

/** What each platform needs before it can publish. */
export function isConnected(row: PlatformRow, creds: Credentials): boolean {
  switch (row.platform) {
    case "youtube":
      return Boolean(creds.refreshToken);
    case "facebook":
      return Boolean(creds.pageAccessToken && row.config.pageId);
    case "instagram":
      return Boolean(creds.accessToken && row.config.igUserId);
  }
}

export function toPlatformAccount(row: PlatformRow, cipher: CredentialCipher): PlatformAccount {
  const creds = safeDecrypt(cipher, row.credentials);
  return {
    platform: row.platform,
    label: PLATFORM_LABELS[row.platform],
    enabled: row.enabled,
    displayName: row.display_name,
    config: row.config ?? {},
    credentialFields: Object.keys(creds).filter((k) => creds[k]),
    connected: isConnected(row, creds),
    captionTemplate: row.caption_template ?? DEFAULT_CAPTION_TEMPLATE,
    hashtags: row.hashtags ?? DEFAULT_HASHTAGS,
    connectedAt: row.connected_at ? new Date(row.connected_at).toISOString() : null,
  };
}

export function safeDecrypt(cipher: CredentialCipher, value: string | null): Credentials {
  try {
    return cipher.decrypt(value);
  } catch {
    // Key rotated or data corrupted: treat as disconnected rather than crashing every request.
    return {};
  }
}

export async function getPlatformRow(db: Db, platform: Platform): Promise<PlatformRow> {
  const row = await db.one<PlatformRow>("SELECT * FROM platform_accounts WHERE platform = $1", [platform]);
  if (!row) throw new HttpError(404, "not_found", "Unknown platform");
  return row;
}

export async function listPlatformRows(db: Db): Promise<PlatformRow[]> {
  return db.query<PlatformRow>("SELECT * FROM platform_accounts ORDER BY platform");
}

export async function saveCredentials(db: Db, cipher: CredentialCipher, platform: Platform, creds: Credentials) {
  const clean = Object.fromEntries(Object.entries(creds).filter(([, v]) => v));
  await db.query("UPDATE platform_accounts SET credentials = $2, updated_at = now() WHERE platform = $1", [
    platform,
    Object.keys(clean).length ? cipher.encrypt(clean) : null,
  ]);
}

export type DraftSource = {
  title: string;
  hook: string | null;
  sourceTitle: string | null;
  sourceChannel: string | null;
  sourceUrl: string | null;
};

export function buildDraft(row: PlatformRow, src: DraftSource): PublishPreview {
  return {
    platform: row.platform,
    title: platformTitle(row.platform, src.title),
    description: renderCaptionTemplate(row.caption_template ?? DEFAULT_CAPTION_TEMPLATE, row.platform, {
      title: src.title,
      hook: src.hook,
      hashtags: row.hashtags ?? DEFAULT_HASHTAGS,
      sourceTitle: src.sourceTitle,
      sourceChannel: src.sourceChannel,
      sourceUrl: src.sourceUrl,
    }),
  };
}
