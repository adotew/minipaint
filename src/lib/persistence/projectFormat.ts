import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from "../core/constants";
import type { ProjectLayerManifest, ProjectManifest } from "../core/types";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid project file: ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`Invalid project file: ${label} must be a string.`);
  return value;
}

function asNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid project file: ${label} must be a number.`);
  }
  return value;
}

function asBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`Invalid project file: ${label} must be a boolean.`);
  return value;
}

export function parseProjectManifest(value: unknown): ProjectManifest {
  const root = asRecord(value, "manifest");
  if (root.format !== "minipaint-project") throw new Error("Unsupported project file format.");
  if (root.version !== 1) throw new Error("Unsupported project file version.");

  const canvas = asRecord(root.canvas, "canvas");
  const width = asNumber(canvas.width, "canvas.width");
  const height = asNumber(canvas.height, "canvas.height");
  if (
    width < MIN_CANVAS_SIZE ||
    height < MIN_CANVAS_SIZE ||
    width > MAX_CANVAS_SIZE ||
    height > MAX_CANVAS_SIZE
  ) {
    throw new Error(`Unsupported canvas size ${width} × ${height}.`);
  }

  const view = asRecord(root.view, "view");
  const brush = asRecord(root.brush, "brush");
  const rawLayers = root.layers;
  if (!Array.isArray(rawLayers) || rawLayers.length === 0) {
    throw new Error("Invalid project file: at least one layer is required.");
  }

  const layersManifest = rawLayers.map((rawLayer, index): ProjectLayerManifest => {
    const layer = asRecord(rawLayer, `layers[${index}]`);
    return {
      id: asString(layer.id, `layers[${index}].id`),
      name: asString(layer.name, `layers[${index}].name`),
      image: asString(layer.image, `layers[${index}].image`),
      visible: asBoolean(layer.visible, `layers[${index}].visible`),
      locked: asBoolean(layer.locked, `layers[${index}].locked`),
    };
  });

  const activeLayerId = root.activeLayerId === null
    ? null
    : asString(root.activeLayerId, "activeLayerId");

  return {
    format: "minipaint-project",
    version: 1,
    canvas: {
      width,
      height,
      background: "#ffffff",
      colorSpace: "srgb",
    },
    activeLayerId,
    view: {
      zoom: asNumber(view.zoom, "view.zoom"),
      offsetX: asNumber(view.offsetX, "view.offsetX"),
      offsetY: asNumber(view.offsetY, "view.offsetY"),
    },
    brush: {
      color: asString(brush.color, "brush.color"),
      size: asNumber(brush.size, "brush.size"),
    },
    layers: layersManifest,
  };
}
