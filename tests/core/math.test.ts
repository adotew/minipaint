import { describe, expect, it } from "vitest";

import { alignTo, clamp, lerp } from "../../src/lib/core/math";

describe("math helpers", () => {
  it("clamps values below the minimum", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it("clamps values above the maximum", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("leaves in-range values unchanged", () => {
    expect(clamp(6, 0, 10)).toBe(6);
  });

  it("linearly interpolates between two values", () => {
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });

  it("aligns values upward to the requested boundary", () => {
    expect(alignTo(257, 256)).toBe(512);
    expect(alignTo(512, 256)).toBe(512);
  });
});
