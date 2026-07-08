import { describe, expect, it } from "vitest";

import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from "../../src/lib/core/constants";
import type { ProjectManifest } from "../../src/lib/core/types";
import { parseProjectManifest } from "../../src/lib/persistence/projectFormat";

function createManifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    format: "minipaint-project",
    version: 1,
    canvas: {
      width: 1024,
      height: 768,
      background: "#ffffff",
      colorSpace: "srgb",
    },
    activeLayerId: "layer-1",
    view: {
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
    },
    brush: {
      color: "#ff0000",
      size: 24,
    },
    layers: [
      {
        id: "layer-1",
        name: "Layer 1",
        image: "layers/layer-1.png",
        visible: true,
        locked: false,
      },
    ],
    ...overrides,
  };
}

describe("parseProjectManifest", () => {
  it("parses a valid project manifest", () => {
    const parsed = parseProjectManifest(createManifest());

    expect(parsed.canvas.width).toBe(1024);
    expect(parsed.activeLayerId).toBe("layer-1");
    expect(parsed.layers).toHaveLength(1);
  });

  it("rejects unsupported project formats", () => {
    expect(() => parseProjectManifest({ ...createManifest(), format: "other-format" })).toThrow(
      "Unsupported project file format.",
    );
  });

  it("rejects manifests without layers", () => {
    expect(() => parseProjectManifest(createManifest({ layers: [] }))).toThrow(
      "at least one layer is required",
    );
  });

  it("rejects canvas sizes below the supported range", () => {
    const manifest = createManifest({
      canvas: {
        width: MIN_CANVAS_SIZE - 1,
        height: 768,
        background: "#ffffff",
        colorSpace: "srgb",
      },
    });

    expect(() => parseProjectManifest(manifest)).toThrow("Unsupported canvas size");
  });

  it("rejects canvas sizes above the supported range", () => {
    const manifest = createManifest({
      canvas: {
        width: 1024,
        height: MAX_CANVAS_SIZE + 1,
        background: "#ffffff",
        colorSpace: "srgb",
      },
    });

    expect(() => parseProjectManifest(manifest)).toThrow("Unsupported canvas size");
  });
});
