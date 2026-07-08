import { describe, expect, it } from "vitest";

import { MAX_BRUSH_SIZE, MIN_PRESSURE_SIZE } from "../../src/lib/core/constants";
import { getBrushRadius, resizeBrushSize } from "../../src/lib/input/brush";

function pointerWithPressure(pressure: number): PointerEvent {
  return { pressure, pointerType: "pen" } as unknown as PointerEvent;
}

describe("brush input helpers", () => {
  it("uses half the brush size when pressure is disabled", () => {
    expect(getBrushRadius(pointerWithPressure(0.1), 20, false, 3)).toBe(10);
  });

  it("scales brush radius from pointer pressure", () => {
    const radius = getBrushRadius(pointerWithPressure(0.5), 100, true, 9);

    expect(radius).toBe(100 * (MIN_PRESSURE_SIZE + (1 - MIN_PRESSURE_SIZE) * 0.5) / 2);
  });

  it("uses the fallback radius when pressure is enabled but absent", () => {
    expect(getBrushRadius(pointerWithPressure(0), 20, true, 7)).toBe(7);
  });

  it("increases brush size when dragging upward", () => {
    expect(resizeBrushSize(20, 100, 80)).toBe(40);
  });

  it("decreases brush size when dragging downward", () => {
    expect(resizeBrushSize(20, 100, 115)).toBe(5);
  });

  it("clamps resized brush sizes to valid bounds", () => {
    expect(resizeBrushSize(20, 100, 500)).toBe(1);
    expect(resizeBrushSize(MAX_BRUSH_SIZE, 100, -1000)).toBe(MAX_BRUSH_SIZE);
  });
});
