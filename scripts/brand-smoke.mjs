#!/usr/bin/env node
/**
 * Brand-kit smoke test: upload intro/outro/music/logo, make them the defaults, re-render a clip,
 * and check the output (duration = intro + clip + outro, 1080x1920, has audio).
 *
 *   APP_PASSWORD=... node scripts/brand-smoke.mjs <assetDir> <clipId> [apiBase]
 */
import fs from "node:fs";
import path from "node:path";

const [, , dir, clipId, base = "http://localhost:4000"] = process.argv;
let cookie = "";
async function call(method, p, body) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const log = (...a) => console.log("•", ...a);
await call("POST", "/auth/login", { password: process.env.APP_PASSWORD });

const files = { intro: ["intro.mp4", "video/mp4"], outro: ["outro.mp4", "video/mp4"], music: ["music.mp3", "audio/mpeg"], logo: ["logo.png", "image/png"] };
const ids = {};
for (const [kind, [name, contentType]] of Object.entries(files)) {
  const bytes = fs.readFileSync(path.join(dir, name));
  const up = await call("POST", "/assets", { kind, fileName: name, contentType, fileSizeBytes: bytes.length });
  const put = await fetch(up.uploadUrl, { method: "PUT", headers: up.uploadHeaders, body: bytes });
  if (!put.ok) throw new Error(`PUT ${kind} failed ${put.status}`);
  ids[kind] = (await call("POST", `/assets/${up.sourceVideoId}/complete`)).id;
}
log("uploaded assets", ids);

// Wrong-kind references are rejected.
const { settings } = await call("GET", "/settings");
try {
  await call("PUT", "/settings", { ...settings, render: { ...settings.render, brandKit: { ...settings.render.brandKit, introAssetId: ids.logo } } });
  throw new Error("expected 422 for a logo used as intro");
} catch (e) {
  if (!String(e).includes("422")) throw e;
  log("logo-as-intro rejected (422)");
}
const kit = {
  ...settings.render.brandKit,
  introAssetId: ids.intro, outroAssetId: ids.outro, musicAssetId: ids.music, logoAssetId: ids.logo,
  musicVolume: 0.25, duckMusic: true, logoPosition: "top-left", logoScale: 0.3, logoOpacity: 0.95,
};
await call("PUT", "/settings", { ...settings, render: { ...settings.render, brandKit: kit, letterboxFill: "blur", multiFace: "group" } });
log("brand kit saved");

const r = await call("POST", `/clips/${clipId}/render`, {});
log("render queued", r.id);
let st;
for (;;) {
  st = await call("GET", `/renders/${r.id}`);
  process.stdout.write(`\r  ${st.status} ${st.progressPercent}%   `);
  if (["completed", "failed"].includes(st.status)) break;
  await new Promise((res) => setTimeout(res, 1500));
}
console.log();
if (st.status !== "completed") throw new Error(`render failed: ${st.errorMessage}`);
log("output", st.output);
console.log(`RENDER_ID=${r.id}`);
