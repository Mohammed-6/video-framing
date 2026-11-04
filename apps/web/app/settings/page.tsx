"use client";

import {
  CAPTION_STYLES,
  CAPTION_STYLE_LABELS,
  TEMPLATE_PLACEHOLDERS,
  type AppSettings,
  type Platform,
  type PlatformAccount,
} from "@clipforge/contracts";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BrandKitSection } from "@/components/BrandKitSection";
import { PlatformDot } from "@/components/PlatformBadge";
import { api, errorMessage, type SettingsResponse } from "@/lib/api";

type FieldDef = { key: string; label: string; kind: "config" | "credential"; type?: "text" | "secret" | "select" | "checkbox"; options?: Record<string, string>; placeholder?: string };

const FIELDS: Record<Platform, FieldDef[]> = {
  youtube: [
    { key: "clientId", label: "OAuth client ID", kind: "credential", type: "text", placeholder: "xxxx.apps.googleusercontent.com" },
    { key: "clientSecret", label: "OAuth client secret", kind: "credential", type: "secret" },
    { key: "privacyStatus", label: "Visibility", kind: "config", type: "select", options: { public: "Public", unlisted: "Unlisted", private: "Private" } },
    { key: "categoryId", label: "Category ID", kind: "config", type: "text", placeholder: "22 (People & Blogs)" },
    { key: "notifySubscribers", label: "Notify subscribers", kind: "config", type: "checkbox" },
  ],
  facebook: [
    { key: "pageId", label: "Page ID", kind: "config", type: "text", placeholder: "1234567890" },
    { key: "pageAccessToken", label: "Page access token (long-lived)", kind: "credential", type: "secret" },
    { key: "graphVersion", label: "Graph API version", kind: "config", type: "text", placeholder: "v23.0" },
  ],
  instagram: [
    { key: "igUserId", label: "Instagram business account ID", kind: "config", type: "text", placeholder: "1784…" },
    { key: "accessToken", label: "Access token (long-lived)", kind: "credential", type: "secret" },
    { key: "shareToFeed", label: "Also share to feed", kind: "config", type: "checkbox" },
    { key: "graphVersion", label: "Graph API version", kind: "config", type: "text", placeholder: "v23.0" },
  ],
};

const HELP: Record<Platform, React.ReactNode> = {
  youtube: (
    <ol className="list-decimal space-y-1 pl-4">
      <li>In Google Cloud Console, enable <b>YouTube Data API v3</b> and create an OAuth client of type <b>Web application</b>.</li>
      <li>Add the redirect URI shown below to the client, paste the ID and secret here, then click <b>Save</b> and <b>Connect</b>.</li>
      <li>Until Google audits your API project, uploads are forced to <b>private</b>.</li>
    </ol>
  ),
  facebook: (
    <ol className="list-decimal space-y-1 pl-4">
      <li>Create a Meta app, add <b>Facebook Login for Business</b>, and request <code>pages_manage_posts</code>, <code>pages_read_engagement</code>, <code>pages_show_list</code>.</li>
      <li>In Graph API Explorer get a user token, exchange it for a long-lived one, then call <code>/me/accounts</code> to get the Page’s ID and access token.</li>
      <li>Reels post to a <b>Page</b>, not a personal profile.</li>
    </ol>
  ),
  instagram: (
    <ol className="list-decimal space-y-1 pl-4">
      <li>The Instagram account must be <b>Business or Creator</b> and linked to a Facebook Page.</li>
      <li>Use a long-lived token with <code>instagram_basic</code> + <code>instagram_content_publish</code>; get the account ID from <code>/&#123;page-id&#125;?fields=instagram_business_account</code>.</li>
    </ol>
  ),
};

function PlatformCard({ account, redirectUri, onChange }: { account: PlatformAccount; redirectUri: string; onChange: (a: PlatformAccount) => void }) {
  const [config, setConfig] = useState<Record<string, unknown>>(account.config);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState(account.captionTemplate);
  const [hashtags, setHashtags] = useState(account.hashtags);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(!account.connected);

  async function run(label: string, fn: () => Promise<PlatformAccount | void>, okText?: string) {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fn();
      if (res) onChange(res);
      if (okText) setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run(
      "save",
      async () => {
        const res = await api.updatePlatform(account.platform, {
          config: config as Record<string, string | boolean | number>,
          credentials: Object.keys(creds).length ? creds : undefined,
          captionTemplate: template,
          hashtags,
        });
        setCreds({});
        return res;
      },
      "Saved",
    );

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center gap-3">
        <PlatformDot platform={account.platform} />
        <h3 className="font-medium">{account.label}</h3>
        <span className={`text-xs ${account.connected ? "text-emerald-400" : "text-zinc-500"}`}>
          {account.connected ? `Connected${account.displayName ? ` · ${account.displayName}` : ""}` : "Not connected"}
        </span>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-brand-500"
            checked={account.enabled}
            disabled={!account.connected && !account.enabled}
            onChange={(e) => run("toggle", () => api.updatePlatform(account.platform, { enabled: e.target.checked }))}
          />
          Enabled
        </label>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Configure"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="rounded-lg bg-zinc-950 p-3 text-xs text-zinc-400">{HELP[account.platform]}</div>
          {account.platform === "youtube" && (
            <div className="text-xs">
              <span className="label">Authorized redirect URI</span>
              <code className="block break-all rounded bg-zinc-950 p-2 text-zinc-200">{redirectUri}</code>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS[account.platform].map((f) => {
              const stored = account.credentialFields.includes(f.key);
              if (f.type === "checkbox") {
                return (
                  <label key={f.key} className="flex items-center gap-2 self-end pb-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-brand-500"
                      checked={config[f.key] !== false && config[f.key] !== "false"}
                      onChange={(e) => setConfig({ ...config, [f.key]: e.target.checked })}
                    />
                    {f.label}
                  </label>
                );
              }
              return (
                <label key={f.key} className="block">
                  <span className="label">
                    {f.label} {stored && <span className="normal-case text-emerald-400">· saved</span>}
                  </span>
                  {f.type === "select" ? (
                    <select className="input" value={String(config[f.key] ?? Object.keys(f.options!)[0])} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}>
                      {Object.entries(f.options!).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  ) : f.kind === "credential" ? (
                    <input
                      className="input"
                      type={f.type === "secret" ? "password" : "text"}
                      autoComplete="off"
                      placeholder={stored ? "•••••• (leave empty to keep)" : f.placeholder}
                      value={creds[f.key] ?? ""}
                      onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })}
                    />
                  ) : (
                    <input
                      className="input"
                      placeholder={f.placeholder}
                      value={String(config[f.key] ?? "")}
                      onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
                    />
                  )}
                </label>
              );
            })}
          </div>
          <label className="block">
            <span className="label">Caption template</span>
            <textarea className="input min-h-[96px] font-mono text-xs" value={template} onChange={(e) => setTemplate(e.target.value)} />
            <span className="mt-1 block text-[11px] text-zinc-500">Placeholders: {TEMPLATE_PLACEHOLDERS.join(" ")}</span>
          </label>
          <label className="block">
            <span className="label">Hashtags</span>
            <input className="input" value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="#shorts #podcast" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={Boolean(busy)} onClick={save}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            {account.platform === "youtube" && (
              <button
                className="btn-secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("connect", async () => {
                    const { url } = await api.youtubeOauthStart();
                    window.location.href = url;
                  })
                }
              >
                {account.connected ? "Reconnect Google account" : "Connect Google account"}
              </button>
            )}
            <button className="btn-secondary" disabled={Boolean(busy)} onClick={() => run("test", () => api.testPlatform(account.platform), "Connection works")}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            {account.connected && (
              <button className="btn-ghost text-red-400" disabled={Boolean(busy)} onClick={() => run("disc", () => api.disconnectPlatform(account.platform))}>
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}
      {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</p>}
    </div>
  );
}

function Defaults({ initial, onSaved }: { initial: SettingsResponse; onSaved: (s: AppSettings) => void }) {
  const [s, setS] = useState<AppSettings>(initial.settings);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const a = s.analysis;
  const r = s.render;
  const setA = (patch: Partial<AppSettings["analysis"]>) => setS({ ...s, analysis: { ...a, ...patch } });
  const setR = (patch: Partial<AppSettings["render"]>) => setS({ ...s, render: { ...r, ...patch } });
  const setBrand = (patch: Partial<AppSettings["render"]["brand"]>) => setR({ brand: { ...r.brand, ...patch } });

  async function save() {
    setMsg(null);
    try {
      const res = await api.saveSettings({
        ...s,
        render: { ...s.render, brandKit: initial.settings.render.brandKit, include: initial.settings.render.include },
      });
      onSaved(res.settings);
      setMsg({ ok: true, text: "Saved" });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    }
  }

  return (
    <div className="card space-y-5 p-5">
      <div>
        <h3 className="font-medium">Clip finding</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Num label="Clips per video" value={a.targetClipCount} min={1} max={15} onChange={(v) => setA({ targetClipCount: v })} />
          <Num label="Min length (s)" value={a.minDurationSeconds} min={5} max={170} onChange={(v) => setA({ minDurationSeconds: v })} />
          <Num label="Max length (s)" value={a.maxDurationSeconds} min={10} max={180} onChange={(v) => setA({ maxDurationSeconds: v })} />
          <label>
            <span className="label">Language</span>
            <select className="input" value={a.language ?? ""} onChange={(e) => setA({ language: e.target.value || undefined })}>
              <option value="">Auto-detect</option>
              {["en", "es", "fr", "de", "pt", "hi", "bn", "ar", "ur"].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div>
        <h3 className="font-medium">Rendering</h3>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-brand-500" checked={s.autoRender} onChange={(e) => setS({ ...s, autoRender: e.target.checked })} />
          Render every clip automatically (so it lands in Review)
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label>
            <span className="label">Framing</span>
            <select className="input" value={r.reframe} onChange={(e) => setR({ reframe: e.target.value as AppSettings["render"]["reframe"] })}>
              <option value="auto">Follow faces</option>
              <option value="center">Center crop</option>
            </select>
          </label>
          <label>
            <span className="label">Zoomed-out bars</span>
            <select className="input" value={r.letterboxFill} onChange={(e) => setR({ letterboxFill: e.target.value as AppSettings["render"]["letterboxFill"] })}>
              <option value="blur">Blurred video</option>
              <option value="black">Black</option>
            </select>
          </label>
          <label>
            <span className="label">Several people</span>
            <select
              className="input"
              value={r.multiFace === "speaker" ? "speaker" : r.steadyZoom ? "steady" : "switch"}
              onChange={(e) => {
                const v = e.target.value;
                setR({ multiFace: v === "speaker" ? "speaker" : "group", steadyZoom: v !== "switch" });
              }}
            >
              <option value="steady">Show everyone, steady layout</option>
              <option value="switch">Show everyone, switch tight/wide</option>
              <option value="speaker">Follow speaker</option>
            </select>
          </label>
          <label>
            <span className="label">Caption style</span>
            <select className="input" value={r.captionStyle} onChange={(e) => setR({ captionStyle: e.target.value as AppSettings["render"]["captionStyle"] })}>
              {CAPTION_STYLES.map((c) => (
                <option key={c} value={c}>
                  {CAPTION_STYLE_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Resolution</span>
            <select className="input" value={r.resolution} onChange={(e) => setR({ resolution: e.target.value as AppSettings["render"]["resolution"] })}>
              <option value="1080x1920">1080×1920</option>
              <option value="720x1280">720×1280</option>
            </select>
          </label>
          <label>
            <span className="label">Highlight</span>
            <input type="color" className="h-9 w-full cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900" value={r.brand.primaryColor ?? "#FFE14D"} onChange={(e) => setBrand({ primaryColor: e.target.value.toUpperCase() })} />
          </label>
          <label>
            <span className="label">Position</span>
            <select className="input" value={r.brand.captionPosition} onChange={(e) => setBrand({ captionPosition: e.target.value as "bottom" | "middle" })}>
              <option value="bottom">Lower third</option>
              <option value="middle">Center</option>
            </select>
          </label>
          <label>
            <span className="label">Watermark</span>
            <input className="input" maxLength={40} placeholder="@yourhandle (optional)" value={r.brand.watermarkText ?? ""} onChange={(e) => setBrand({ watermarkText: e.target.value || undefined })} />
          </label>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save}>
          Save defaults
        </button>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</span>}
      </div>
      <p className="text-xs text-zinc-500">
        Environment: YouTube search {initial.environment.youtubeSearchEnabled ? "on" : "off (set YOUTUBE_API_KEY)"} · storage {initial.environment.storageDriver}
      </p>
    </div>
  );
}

function Num({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label>
      <span className="label">{label}</span>
      <input className="input" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function SettingsView() {
  const [platforms, setPlatforms] = useState<PlatformAccount[] | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.platforms().then((r) => (setPlatforms(r.platforms), setRedirectUri(r.youtubeRedirectUri)));
    api.settings().then(setSettings);
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) setBanner({ ok: true, text: `Connected ${params.get("connected")}` });
    if (params.get("error")) setBanner({ ok: false, text: params.get("error")! });
    if (params.size) window.history.replaceState(null, "", "/settings");
  }, []);

  return (
    <div className="max-w-4xl space-y-8">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {banner && <p className={`rounded-lg p-3 text-sm ${banner.ok ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"}`}>{banner.text}</p>}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Publishing platforms</h2>
        {platforms?.map((p) => (
          <PlatformCard key={p.platform} account={p} redirectUri={redirectUri} onChange={(a) => setPlatforms((ps) => ps!.map((x) => (x.platform === a.platform ? a : x)))} />
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Brand kit</h2>
        {settings && <BrandKitSection settings={settings.settings} onSaved={(s) => setSettings({ ...settings, settings: s })} />}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Pipeline defaults</h2>
        {settings && <Defaults initial={settings} onSaved={(s) => setSettings({ ...settings, settings: s })} />}
      </section>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <AppShell>
      <SettingsView />
    </AppShell>
  );
}
