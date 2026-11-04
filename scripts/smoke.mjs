#!/usr/bin/env node
/**
 * End-to-end smoke test against a running stack (docker compose up) with PUBLISH_DRY_RUN=true:
 *   login -> upload a file (or import a YouTube URL) -> download/transcribe/select -> auto-render
 *   -> review queue -> publish (dry run) -> published list.
 *
 *   APP_PASSWORD=... node scripts/smoke.mjs ./video.mp4
 *   APP_PASSWORD=... node scripts/smoke.mjs https://www.youtube.com/watch?v=...
 */
import fs from "node:fs";
import path from "node:path";

const [, , source, base = "http://localhost:4000"] = process.argv;
const password = process.env.APP_PASSWORD;
if (!source || !password) {
  console.error("usage: APP_PASSWORD=... node scripts/smoke.mjs <video.mp4 | youtube-url> [apiBaseUrl]");
  process.exit(2);
}

let cookie = "";
async function call(method, p, body) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(data)}`);
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("•", ...a);
async function poll(fn, done, label, ms = 2000) {
  for (;;) {
    const v = await fn();
    process.stdout.write(`\r  ${label(v)}`.padEnd(100));
    if (done(v)) return console.log(), v;
    await sleep(ms);
  }
}

// 1. auth
const bad = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"password":"wrong"}' });
if (bad.status !== 401) throw new Error(`wrong password returned ${bad.status}`);
const anon = await fetch(`${base}/api/v1/videos`);
if (anon.status !== 401) throw new Error(`unauthenticated request returned ${anon.status}`);
await call("POST", "/auth/login", { password });
log("logged in (wrong password and anonymous access rejected)");

// 2. source
const analysis = { targetClipCount: 3, minDurationSeconds: 8, maxDurationSeconds: 30 };
let videoId, jobId;
if (/^https?:\/\//.test(source)) {
  const { data } = await call("POST", "/youtube/import", { videos: [source], analysis });
  if (!data.queued.length) throw new Error(`import skipped: ${JSON.stringify(data.skipped)}`);
  ({ sourceVideoId: videoId, jobId } = data.queued[0]);
  log("youtube import queued", videoId);
} else {
  const bytes = fs.readFileSync(source);
  const { data: up } = await call("POST", "/uploads", { fileName: path.basename(source), contentType: "video/mp4", fileSizeBytes: bytes.length });
  const put = await fetch(up.uploadUrl, { method: "PUT", headers: up.uploadHeaders, body: bytes });
  if (!put.ok) throw new Error(`upload PUT failed: ${put.status}`);
  await call("POST", `/uploads/${up.sourceVideoId}/complete`, { sourceVideoId: up.sourceVideoId, blobKey: up.blobKey });
  const { data } = await call("POST", `/videos/${up.sourceVideoId}/analyze`, analysis);
  videoId = up.sourceVideoId;
  jobId = data.jobId;
  log("uploaded", bytes.length, "bytes; analysis queued");
}

// 3. pipeline
const job = await poll(
  async () => (await call("GET", `/jobs/${jobId}`)).data,
  (j) => ["clips_ready", "failed", "cancelled"].includes(j.status),
  (j) => `${j.status.padEnd(17)} ${String(j.progressPercent).padStart(3)}%  ${j.stage ?? ""}`,
);
if (job.status !== "clips_ready") throw new Error(`pipeline ${job.status}: ${job.errorCode} ${job.errorMessage}`);
const { data: video } = await call("GET", `/videos/${videoId}`);
log(`"${video.title}" ${video.width}x${video.height} ${video.durationSeconds?.toFixed(1)}s — ${job.stage}`);

// 4. auto-render
const clips = await poll(
  async () => (await call("GET", `/videos/${videoId}/clips`)).data.clips,
  (cs) => cs.every((c) => ["completed", "failed"].includes(c.latestRender?.status)),
  (cs) => `auto-render: ${cs.filter((c) => c.latestRender?.status === "completed").length}/${cs.length} done`,
);
for (const c of clips) console.log(`   [${c.score?.toFixed(2)}] ${c.startSeconds.toFixed(1)}-${c.endSeconds.toFixed(1)}s ${c.status.padEnd(9)} ${c.title}`);
if (clips.some((c) => c.latestRender?.status !== "completed")) throw new Error("a render failed");

// 5. review queue + platform setup (fake credentials; worker must run with PUBLISH_DRY_RUN=true)
await call("PATCH", "/platforms/facebook", { enabled: true, config: { pageId: "123" }, credentials: { pageAccessToken: "dry-run" } });
await call("PATCH", "/platforms/instagram", { enabled: true, config: { igUserId: "456" }, credentials: { accessToken: "dry-run" } });
const { data: review } = await call("GET", "/review");
const item = review.items.find((i) => i.sourceVideo.id === videoId);
if (!item) throw new Error("rendered clip missing from review queue");
log(`review queue has ${review.items.length} item(s); platforms ready: ${review.readyPlatforms.join(", ")}`);
console.log("   facebook draft:\n" + item.drafts.find((d) => d.platform === "facebook").description.replace(/^/gm, "     | "));

// 6. publish now
const { data: pub } = await call("POST", `/clips/${item.id}/publish`, { targets: [{ platform: "facebook" }, { platform: "instagram", title: "Custom IG title" }] });
log(`queued ${pub.publications.length} posts`);
const dup = await fetch(`${base}/api/v1/clips/${item.id}/publish`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ targets: [{ platform: "facebook" }] }),
});
if (dup.status !== 409) throw new Error(`duplicate publish returned ${dup.status}`);
log("duplicate post to the same platform rejected (409)");

const done = await poll(
  async () => (await call("GET", `/clips/${item.id}/publications`)).data.publications,
  (ps) => ps.every((p) => ["published", "failed"].includes(p.status)),
  (ps) => ps.map((p) => `${p.platform}:${p.status}`).join("  "),
  1000,
);
for (const p of done) console.log(`   ${p.platform.padEnd(10)} ${p.status} ${p.externalUrl ?? p.errorMessage}`);
if (done.some((p) => p.status !== "published")) throw new Error("publish failed");

const { data: clipAfter } = await call("GET", `/clips/${item.id}`);
if (clipAfter.status !== "published") throw new Error(`clip status ${clipAfter.status}`);
const { data: reviewAfter } = await call("GET", "/review");
if (reviewAfter.items.some((i) => i.id === item.id)) throw new Error("published clip still in review queue");
log("clip marked published and removed from review queue");

console.log("\nSMOKE TEST PASSED");
