import { describe, expect, it } from "vitest";
import { validateClipBounds } from "./validation";

describe("validateClipBounds", () => {
  it("accepts a clip inside the source", () => {
    expect(validateClipBounds(10, 40, 120)).toEqual({ ok: true, start: 10, end: 40 });
  });

  it("rejects inverted bounds", () => {
    expect(validateClipBounds(40, 10, 120).ok).toBe(false);
  });

  it("rejects clips past the end of the source", () => {
    expect(validateClipBounds(100, 130, 120).ok).toBe(false);
  });

  it("clamps sub-50ms overshoot caused by float/frame rounding", () => {
    expect(validateClipBounds(100, 120.03, 120)).toEqual({ ok: true, start: 100, end: 120 });
  });

  it("enforces min and max length", () => {
    expect(validateClipBounds(0, 1, 120).ok).toBe(false);
    expect(validateClipBounds(0, 500, 1000).ok).toBe(false);
  });

  it("allows unknown duration", () => {
    expect(validateClipBounds(5, 30, null).ok).toBe(true);
  });
});
