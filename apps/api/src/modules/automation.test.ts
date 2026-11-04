import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeHashtags, parseYoutubeId, platformTitle, renderCaptionTemplate } from "@clipforge/contracts";
import { CredentialCipher } from "../crypto";
import { parseIsoDuration } from "./youtube/client";

describe("parseYoutubeId", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://vimeo.com/123", null],
    ["not an id", null],
  ])("%s -> %s", (input, expected) => {
    expect(parseYoutubeId(input)).toBe(expected);
  });
});

describe("parseIsoDuration", () => {
  it("parses YouTube durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45M")).toBe(2700);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(parseIsoDuration("P0D")).toBe(0);
    expect(parseIsoDuration("garbage")).toBeNull();
  });
});

describe("caption templates", () => {
  const ctx = {
    title: "Why startups fail",
    hook: "The biggest mistake founders make...",
    hashtags: "shorts, #startup #startup founders!",
    sourceTitle: "Founder Podcast #42",
    sourceChannel: "Founder Pod",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  };

  it("fills placeholders and normalizes hashtags", () => {
    const out = renderCaptionTemplate("{hook}\n\n{hashtags}\n\nCredit: {source_channel} — {source_url}", "instagram", ctx);
    expect(out).toBe(
      "The biggest mistake founders make...\n\n#shorts #startup #founders\n\nCredit: Founder Pod — https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("drops lines with any empty placeholder (uploads have no source channel/url)", () => {
    const tpl = "{hook}\n\nCredit: \"{source_title}\" by {source_channel} — {source_url}";
    const out = renderCaptionTemplate(tpl, "facebook", { ...ctx, sourceChannel: null, sourceUrl: null });
    expect(out).toBe("The biggest mistake founders make...");
  });

  it("caps hashtags and adds #Shorts to YouTube titles", () => {
    expect(normalizeHashtags("a b c d", 2)).toBe("#a #b");
    expect(platformTitle("youtube", "Hello")).toBe("Hello #Shorts");
    expect(platformTitle("youtube", "Hello #shorts")).toBe("Hello #shorts");
    expect(platformTitle("facebook", "Hello")).toBe("Hello");
  });
});

describe("CredentialCipher", () => {
  const key = crypto.randomBytes(32).toString("base64");

  it("round-trips and uses fresh IVs", () => {
    const c = new CredentialCipher(key);
    const a = c.encrypt({ token: "secret" });
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toBe(c.encrypt({ token: "secret" }));
    expect(c.decrypt(a)).toEqual({ token: "secret" });
    expect(c.decrypt(null)).toEqual({});
  });

  it("rejects tampering and wrong keys", () => {
    const c = new CredentialCipher(key);
    const enc = c.encrypt({ token: "secret" });
    const raw = Buffer.from(enc.slice(3), "base64");
    raw[20] ^= 1;
    expect(() => c.decrypt(`v1:${raw.toString("base64")}`)).toThrow();
    expect(() => new CredentialCipher(crypto.randomBytes(32).toString("base64")).decrypt(enc)).toThrow();
  });
});

describe("render defaults", () => {
  it("old settings get every piece switched on and the steady layout", async () => {
    const { AppSettings, RenderClipRequest } = await import("@clipforge/contracts");
    const r = AppSettings.parse({ render: { multiFace: "group" } }).render;
    expect(r.include).toEqual({ intro: true, outro: true, music: true, logo: true, captions: true });
    expect(r.steadyZoom).toBe(true);
    expect(RenderClipRequest.parse({ include: { captions: false } }).include).toEqual({ captions: false });
  });
});
