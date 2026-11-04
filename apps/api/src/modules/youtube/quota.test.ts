import { describe, expect, it } from "vitest";
import { YoutubeSearchQuery } from "@clipforge/contracts";
import { YoutubeClient, searchCacheKey } from "./client";
import { TtlCache } from "./quota";

type Call = { path: string; params: URLSearchParams };

function fakeYoutube(handler?: (c: Call) => { status: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    const call = { path: u.pathname.split("/").pop()!, params: u.searchParams };
    calls.push(call);
    const custom = handler?.(call);
    if (custom) return new Response(JSON.stringify(custom.body), { status: custom.status });
    if (call.path === "search") {
      return Response.json({ items: [{ id: { videoId: "aaaaaaaaaaa" } }, { id: { videoId: "bbbbbbbbbbb" } }], pageInfo: { totalResults: 2 } });
    }
    const ids = call.params.get("id")!.split(",");
    return Response.json({
      items: ids.map((id) => ({ id, snippet: { title: `T ${id}` }, contentDetails: { duration: "PT30M" }, statistics: {}, status: {} })),
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function tracked(handler?: Parameters<typeof fakeYoutube>[0]) {
  const { calls, fetchImpl } = fakeYoutube(handler);
  const spent: string[] = [];
  let exhausted = 0;
  const yt = new YoutubeClient("key", fetchImpl, {
    onSpend: (e) => void spent.push(e),
    onExhausted: () => void exhausted++,
  });
  return { yt, calls, spent, exhausted: () => exhausted };
}

const query = (q: string, extra: Partial<YoutubeSearchQuery> = {}) => YoutubeSearchQuery.parse({ q, ...extra });

describe("YouTube quota + cache", () => {
  it("serves a repeated search from cache without spending quota", async () => {
    const { yt, calls, spent } = tracked();
    const first = await yt.search(query("Startup Podcast"));
    const again = await yt.search(query("  startup   podcast "));
    expect(first.cached).toBe(false);
    expect(again).toMatchObject({ cached: true, ids: first.ids });
    expect(calls.map((c) => c.path)).toEqual(["search"]);
    expect(spent).toEqual(["search"]);
  });

  it("treats different filters and pages as different searches", () => {
    expect(searchCacheKey(query("x"))).not.toBe(searchCacheKey(query("x", { order: "date" })));
    expect(searchCacheKey(query("x"))).not.toBe(searchCacheKey(query("x", { pageToken: "P2" })));
  });

  it("only fetches video details that aren't cached", async () => {
    const { yt, calls, spent } = tracked();
    await yt.videos(["aaaaaaaaaaa"]);
    const both = await yt.videos(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(both.map((v) => v.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(calls[1].params.get("id")).toBe("bbbbbbbbbbb");
    await yt.videos(["bbbbbbbbbbb", "aaaaaaaaaaa"]);
    expect(calls).toHaveLength(2);
    expect(spent).toEqual(["videos", "videos"]);
  });

  it("reports quotaExceeded as a 429 and records exhaustion, without counting units", async () => {
    const { yt, spent, exhausted } = tracked(() => ({
      status: 403,
      body: { error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } },
    }));
    await expect(yt.search(query("x"))).rejects.toMatchObject({ status: 429, code: "youtube_quota_exceeded" });
    expect(exhausted()).toBe(1);
    expect(spent).toEqual([]);
  });

  it("doesn't cache failures and survives a broken tracker", async () => {
    let fail = true;
    const { fetchImpl, calls } = fakeYoutube(() => (fail ? { status: 500, body: {} } : undefined));
    const yt = new YoutubeClient("key", fetchImpl, { onSpend: () => Promise.reject(new Error("db down")) });
    await expect(yt.search(query("x"))).rejects.toMatchObject({ status: 502 });
    fail = false;
    expect((await yt.search(query("x"))).ids).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("TtlCache expires and evicts the oldest entry", () => {
    let now = 0;
    const c = new TtlCache<number>(1000, 2, () => now);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("c")).toBe(3);
    now = 1000;
    expect(c.get("b")).toBeUndefined();
  });
});
