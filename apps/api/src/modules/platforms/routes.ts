import { Router } from "express";
import jwt from "jsonwebtoken";
import { Platform, UpdatePlatformRequest } from "@clipforge/contracts";
import type { AppDeps } from "../../deps";
import { HttpError, parseBody } from "../../http/errors";
import {
  getPlatformRow,
  listPlatformRows,
  safeDecrypt,
  saveCredentials,
  toPlatformAccount,
} from "./service";
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, YOUTUBE_SCOPES, googleAccessToken, verifyPlatform, youtubeChannel } from "./verify";

/** Fields that live in `config` (non-secret) per platform; everything else is rejected. */
const CONFIG_FIELDS: Record<Platform, string[]> = {
  youtube: ["privacyStatus", "categoryId", "notifySubscribers", "addShortsTag"],
  facebook: ["pageId", "graphVersion"],
  instagram: ["igUserId", "graphVersion", "shareToFeed"],
};
const CREDENTIAL_FIELDS: Record<Platform, string[]> = {
  youtube: ["clientId", "clientSecret"], // refreshToken comes from the OAuth callback only
  facebook: ["pageAccessToken"],
  instagram: ["accessToken"],
};

function platformParam(value: unknown): Platform {
  const p = Platform.safeParse(value);
  if (!p.success) throw new HttpError(404, "not_found", "Unknown platform");
  return p.data;
}

export function platformsRouter(deps: AppDeps): Router {
  const { cfg, db, cipher } = deps;
  const router = Router();
  const redirectUri = `${cfg.WEB_ORIGIN}/api/v1/platforms/youtube/oauth/callback`;

  router.get("/", async (_req, res) => {
    const rows = await listPlatformRows(db);
    res.json({ platforms: rows.map((r) => toPlatformAccount(r, cipher)), youtubeRedirectUri: redirectUri });
  });

  router.patch("/:platform", async (req, res) => {
    const platform = platformParam(req.params.platform);
    const body = parseBody(UpdatePlatformRequest, req.body);
    const row = await getPlatformRow(db, platform);

    const badConfig = Object.keys(body.config ?? {}).filter((k) => !CONFIG_FIELDS[platform].includes(k));
    const badCreds = Object.keys(body.credentials ?? {}).filter((k) => !CREDENTIAL_FIELDS[platform].includes(k));
    if (badConfig.length || badCreds.length) {
      throw new HttpError(400, "unknown_fields", `Unknown fields: ${[...badConfig, ...badCreds].join(", ")}`);
    }

    if (body.credentials) {
      const merged = { ...safeDecrypt(cipher, row.credentials), ...body.credentials };
      // Changing the OAuth client invalidates the stored refresh token.
      if (platform === "youtube" && (body.credentials.clientId !== undefined || body.credentials.clientSecret !== undefined)) {
        delete merged.refreshToken;
      }
      await saveCredentials(db, cipher, platform, merged);
    }
    const config = { ...row.config, ...(body.config ?? {}) };
    const updated = await db.one(
      `UPDATE platform_accounts
          SET enabled = $2, config = $3, caption_template = $4, hashtags = $5, updated_at = now()
        WHERE platform = $1 RETURNING *`,
      [
        platform,
        body.enabled ?? row.enabled,
        JSON.stringify(config),
        body.captionTemplate ?? row.caption_template,
        body.hashtags ?? row.hashtags,
      ],
    );
    res.json(toPlatformAccount(updated, cipher));
  });

  router.post("/:platform/test", async (req, res) => {
    const platform = platformParam(req.params.platform);
    const row = await getPlatformRow(db, platform);
    const name = await verifyPlatform(deps.fetch, platform, row.config, safeDecrypt(cipher, row.credentials), {
      id: cfg.GOOGLE_OAUTH_CLIENT_ID,
      secret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
    });
    const updated = await db.one(
      `UPDATE platform_accounts SET display_name = $2, connected_at = COALESCE(connected_at, now()), updated_at = now()
        WHERE platform = $1 RETURNING *`,
      [platform, name],
    );
    res.json(toPlatformAccount(updated, cipher));
  });

  router.post("/:platform/disconnect", async (req, res) => {
    const platform = platformParam(req.params.platform);
    const row = await getPlatformRow(db, platform);
    // Keep the YouTube OAuth client so reconnecting is one click.
    const keep = platform === "youtube" ? safeDecrypt(cipher, row.credentials) : {};
    await saveCredentials(db, cipher, platform, { clientId: keep.clientId ?? "", clientSecret: keep.clientSecret ?? "" });
    const updated = await db.one(
      `UPDATE platform_accounts SET enabled = false, display_name = NULL, connected_at = NULL, updated_at = now()
        WHERE platform = $1 RETURNING *`,
      [platform],
    );
    res.json(toPlatformAccount(updated, cipher));
  });

  // ---- YouTube OAuth (offline access -> refresh token) ----------------------

  async function youtubeClient() {
    const creds = safeDecrypt(cipher, (await getPlatformRow(db, "youtube")).credentials);
    const id = creds.clientId || cfg.GOOGLE_OAUTH_CLIENT_ID;
    const secret = creds.clientSecret || cfg.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!id || !secret) {
      throw new HttpError(422, "oauth_client_missing", "Add your Google OAuth client ID and secret first");
    }
    return { id, secret, creds };
  }

  router.get("/youtube/oauth/start", async (_req, res) => {
    const client = await youtubeClient();
    const state = jwt.sign({ purpose: "youtube_oauth" }, cfg.JWT_SECRET, { expiresIn: 600, algorithm: "HS256" });
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: client.id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: YOUTUBE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent", // always return a refresh token
      include_granted_scopes: "true",
      state,
    }).toString();
    res.json({ url: url.toString() });
  });

  router.get("/youtube/oauth/callback", async (req, res) => {
    const back = (q: string) => res.redirect(`${cfg.WEB_ORIGIN}/settings?${q}`);
    try {
      const claims = jwt.verify(String(req.query.state ?? ""), cfg.JWT_SECRET, { algorithms: ["HS256"] }) as {
        purpose?: string;
      };
      if (claims.purpose !== "youtube_oauth") throw new Error("wrong purpose");
    } catch {
      return back("error=" + encodeURIComponent("OAuth state expired, try again"));
    }
    if (req.query.error) return back("error=" + encodeURIComponent(`Google: ${req.query.error}`));
    const client = await youtubeClient();
    const tokenRes = await deps.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code ?? ""),
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokens: any = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokens.refresh_token) {
      return back("error=" + encodeURIComponent(tokens.error_description ?? "Google did not return a refresh token"));
    }
    let channelTitle = "YouTube";
    try {
      channelTitle = (await youtubeChannel(deps.fetch, tokens.access_token ?? (await googleAccessToken(deps.fetch, { clientId: client.id, clientSecret: client.secret, refreshToken: tokens.refresh_token })))).title;
    } catch {
      /* channel lookup is cosmetic */
    }
    await saveCredentials(db, cipher, "youtube", { ...client.creds, refreshToken: tokens.refresh_token });
    await db.query(
      `UPDATE platform_accounts SET enabled = true, display_name = $1, connected_at = now(), updated_at = now()
        WHERE platform = 'youtube'`,
      [channelTitle],
    );
    return back("connected=youtube");
  });

  return router;
}
