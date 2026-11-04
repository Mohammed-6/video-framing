"use client";

import {
  type BrandInclude,
  ASSET_CONTENT_TYPES,
  ASSET_KIND_LABELS,
  ASSET_MAX_BYTES,
  LOGO_POSITIONS,
  type AppSettings,
  type AssetKind,
  type BrandAsset,
  type BrandKit,
} from "@clipforge/contracts";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, uploadToSignedUrl } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { IncludeToggles } from "./IncludeToggles";

const KIND_FIELD: Record<AssetKind, keyof BrandKit> = {
  intro: "introAssetId",
  outro: "outroAssetId",
  music: "musicAssetId",
  logo: "logoAssetId",
};

const HINTS: Record<AssetKind, string> = {
  intro: "Short clip (2–5 s works best) shown before every short. Any size: it's fitted to 9:16.",
  outro: "Shown after every short — e.g. “Follow for more”.",
  music: "Plays quietly under the whole short and dips when someone talks. Use royalty-free music: platforms may mute or block copyrighted tracks.",
  logo: "PNG with a transparent background looks best.",
};

function guessType(kind: AssetKind, file: File): string | null {
  if (ASSET_CONTENT_TYPES[kind].includes(file.type)) return file.type;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  const t = map[ext];
  return t && ASSET_CONTENT_TYPES[kind].includes(t) ? t : null;
}

function AssetPreview({ asset }: { asset: BrandAsset }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    api.assetUrl(asset.id).then((u) => setUrl(u.url), () => setUrl(null));
  }, [asset.id]);
  if (!url) return <div className="h-12 w-20 rounded bg-zinc-800" />;
  if (asset.kind === "logo") return <img src={url} alt="" className="h-12 w-20 rounded bg-[repeating-conic-gradient(#333_0_25%,#222_0_50%)] bg-[length:12px_12px] object-contain" />;
  if (asset.kind === "music") return <audio src={url} controls preload="none" className="h-8 w-56" />;
  return <video src={url} controls preload="metadata" className="h-24 rounded bg-black" />;
}

function KindCard({
  kind,
  assets,
  selected,
  onSelect,
  onChanged,
  children,
}: {
  kind: AssetKind;
  assets: BrandAsset[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  children?: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ progress?: number; error?: string }>({});

  async function upload(file: File) {
    const contentType = guessType(kind, file);
    if (!contentType) return setState({ error: "Unsupported file type" });
    if (file.size > ASSET_MAX_BYTES[kind]) return setState({ error: `Max ${formatBytes(ASSET_MAX_BYTES[kind])}` });
    setState({ progress: 0 });
    try {
      const up = await api.createAssetUpload({ kind, fileName: file.name, contentType, fileSizeBytes: file.size });
      await uploadToSignedUrl(up.uploadUrl, up.uploadHeaders, file, (progress) => setState({ progress }));
      const asset = await api.completeAsset(up.sourceVideoId);
      setState({});
      onChanged();
      onSelect(asset.id); // a fresh upload becomes the default
    } catch (e) {
      setState({ error: errorMessage(e) });
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="font-medium">{ASSET_KIND_LABELS[kind]}</h4>
        <span className="text-xs text-zinc-500">{selected ? "in use" : "off"}</span>
        <input
          ref={input}
          type="file"
          className="hidden"
          accept={ASSET_CONTENT_TYPES[kind].join(",")}
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
        <button className="btn-secondary ml-auto py-1 text-xs" disabled={state.progress !== undefined} onClick={() => input.current?.click()}>
          {state.progress !== undefined ? `Uploading ${Math.round(state.progress * 100)}%` : "Upload"}
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">{HINTS[kind]}</p>
      {state.error && <p className="mt-1 text-xs text-red-400">{state.error}</p>}
      {assets.length > 0 && (
        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input type="radio" className="accent-brand-500" checked={!selected} onChange={() => onSelect(null)} />
            None
          </label>
          {assets.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" className="accent-brand-500" checked={selected === a.id} onChange={() => onSelect(a.id)} />
                <span className="max-w-[12rem] truncate">{a.name}</span>
              </label>
              <AssetPreview asset={a} />
              <span className="text-xs text-zinc-500">{formatBytes(a.fileSizeBytes)}</span>
              <button
                className="btn-ghost ml-auto px-2 py-0.5 text-xs text-red-400"
                onClick={async () => {
                  if (!window.confirm(`Delete “${a.name}”? Shorts already rendered keep it.`)) return;
                  await api.deleteAsset(a.id).catch(() => undefined);
                  onChanged();
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

/** Brand kit editor. Saves only `render.brandKit`, merged into the latest full settings. */
export function BrandKitSection({ settings, onSaved }: { settings: AppSettings; onSaved: (s: AppSettings) => void }) {
  const [assets, setAssets] = useState<BrandAsset[]>([]);
  const [kit, setKit] = useState<BrandKit>(settings.render.brandKit);
  const [include, setIncludeState] = useState<BrandInclude>(settings.render.include);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const latest = useRef(settings);
  latest.current = settings;

  const loadAssets = () => api.assets().then((r) => setAssets(r.assets)).catch(() => undefined);
  useEffect(() => {
    loadAssets();
  }, []);

  async function save(next: BrandKit) {
    setKit(next);
    setMsg(null);
    try {
      const res = await api.saveSettings({ ...latest.current, render: { ...latest.current.render, brandKit: next } });
      onSaved(res.settings);
      setMsg({ ok: true, text: "Saved" });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    }
  }

  async function saveInclude(next: BrandInclude) {
    setIncludeState(next);
    setMsg(null);
    try {
      const res = await api.saveSettings({ ...latest.current, render: { ...latest.current.render, include: next } });
      onSaved(res.settings);
      setMsg({ ok: true, text: "Saved" });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    }
  }

  const card = (kind: AssetKind, extra?: React.ReactNode) => (
    <KindCard
      kind={kind}
      assets={assets.filter((a) => a.kind === kind)}
      selected={kit[KIND_FIELD[kind]] as string | null}
      onSelect={(id) => save({ ...kit, [KIND_FIELD[kind]]: id })}
      onChanged={async () => {
        await loadAssets();
        // A deleted default is cleared server-side; refresh our copy.
        const s = await api.settings();
        setKit(s.settings.render.brandKit);
        onSaved(s.settings);
      }}
    >
      {extra}
    </KindCard>
  );

  return (
    <div className="card space-y-3 p-5">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
        <h4 className="font-medium">Include in every short</h4>
        <p className="mb-3 mt-1 text-xs text-zinc-500">
          Untick to leave something out of new renders without deleting the file. You can still change it per clip in the
          editor or on a Review card.
        </p>
        <IncludeToggles value={include} onChange={saveInclude} brandKit={kit} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {card("intro")}
        {card("outro")}
        {card(
          "music",
          kit.musicAssetId && (
            <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-zinc-800 pt-3 text-sm">
              <label className="flex items-center gap-2">
                Volume
                <input type="range" min={0.02} max={0.6} step={0.01} value={kit.musicVolume} onChange={(e) => setKit({ ...kit, musicVolume: +e.target.value })} onMouseUp={() => save(kit)} onTouchEnd={() => save(kit)} className="accent-brand-500" />
                <span className="w-8 tabular-nums text-zinc-400">{Math.round(kit.musicVolume * 100)}%</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-brand-500" checked={kit.duckMusic} onChange={(e) => save({ ...kit, duckMusic: e.target.checked })} />
                Lower under speech
              </label>
            </div>
          ),
        )}
        {card(
          "logo",
          kit.logoAssetId && (
            <div className="mt-3 grid grid-cols-3 gap-3 border-t border-zinc-800 pt-3 text-sm">
              <label>
                <span className="label">Corner</span>
                <select className="input py-1" value={kit.logoPosition} onChange={(e) => save({ ...kit, logoPosition: e.target.value as BrandKit["logoPosition"] })}>
                  {LOGO_POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p.replace("-", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="label">Size {Math.round(kit.logoScale * 100)}%</span>
                <input type="range" min={0.05} max={0.5} step={0.01} value={kit.logoScale} onChange={(e) => setKit({ ...kit, logoScale: +e.target.value })} onMouseUp={() => save(kit)} onTouchEnd={() => save(kit)} className="w-full accent-brand-500" />
              </label>
              <label>
                <span className="label">Opacity {Math.round(kit.logoOpacity * 100)}%</span>
                <input type="range" min={0.1} max={1} step={0.05} value={kit.logoOpacity} onChange={(e) => setKit({ ...kit, logoOpacity: +e.target.value })} onMouseUp={() => save(kit)} onTouchEnd={() => save(kit)} className="w-full accent-brand-500" />
              </label>
            </div>
          ),
        )}
      </div>
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</p>}
    </div>
  );
}
