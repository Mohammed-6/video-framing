/** Live credential checks used by "Test connection" and after OAuth. */
import type { Platform } from "@clipforge/contracts";
import type { Credentials } from "../../crypto";
import { HttpError } from "../../http/errors";
import { DEFAULT_GRAPH_VERSION } from "./service";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

async function json(res: Response) {
  return (await res.json().catch(() => ({}))) as any;
}

export async function googleAccessToken(
  fetchImpl: typeof fetch,
  creds: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<string> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await json(res);
  if (!res.ok || !body.access_token) {
    throw new HttpError(502, "oauth_refresh_failed", `Google token refresh failed: ${body.error_description ?? body.error ?? res.status}`);
  }
  return body.access_token;
}

export async function youtubeChannel(fetchImpl: typeof fetch, accessToken: string): Promise<{ id: string; title: string }> {
  const res = await fetchImpl("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await json(res);
  const ch = body.items?.[0];
  if (!res.ok || !ch) throw new HttpError(502, "youtube_channel_missing", body.error?.message ?? "No YouTube channel on this Google account");
  return { id: ch.id, title: ch.snippet?.title ?? ch.id };
}

async function graphGet(fetchImpl: typeof fetch, version: string, path: string, token: string, fields: string) {
  const res = await fetchImpl(`https://graph.facebook.com/${version}/${path}?fields=${fields}&access_token=${encodeURIComponent(token)}`);
  const body = await json(res);
  if (!res.ok) throw new HttpError(502, "graph_api_error", body.error?.message ?? `Graph API error ${res.status}`);
  return body;
}

/** Returns a display name for the connected account, or throws with the platform's error message. */
export async function verifyPlatform(
  fetchImpl: typeof fetch,
  platform: Platform,
  config: Record<string, unknown>,
  creds: Credentials,
  envClient: { id?: string; secret?: string },
): Promise<string> {
  const version = String(config.graphVersion || DEFAULT_GRAPH_VERSION);
  switch (platform) {
    case "youtube": {
      const clientId = creds.clientId || envClient.id;
      const clientSecret = creds.clientSecret || envClient.secret;
      if (!clientId || !clientSecret || !creds.refreshToken) {
        throw new HttpError(422, "not_connected", "Connect your YouTube account first");
      }
      const token = await googleAccessToken(fetchImpl, { clientId, clientSecret, refreshToken: creds.refreshToken });
      return (await youtubeChannel(fetchImpl, token)).title;
    }
    case "facebook": {
      if (!config.pageId || !creds.pageAccessToken) throw new HttpError(422, "not_connected", "Set the Page ID and Page access token");
      const page = await graphGet(fetchImpl, version, String(config.pageId), creds.pageAccessToken, "id,name");
      return page.name ?? page.id;
    }
    case "instagram": {
      if (!config.igUserId || !creds.accessToken) {
        throw new HttpError(422, "not_connected", "Set the Instagram business account ID and access token");
      }
      const ig = await graphGet(fetchImpl, version, String(config.igUserId), creds.accessToken, "id,username");
      return ig.username ? `@${ig.username}` : ig.id;
    }
  }
}
