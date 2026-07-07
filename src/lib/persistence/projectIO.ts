import type { LayerId, LayerMetadata, ProjectLayerManifest, ProjectManifest } from "../core/types";
import { blobToBytes, bytesToBlob, pixelsToPngBlob, pngBlobToPixels, premultiplyPixels, unpremultiplyPixels } from "./png";
import { parseProjectManifest } from "./projectFormat";
import { createZipBlob, readZipEntries, type ZipEntry } from "./zip";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type ProjectLayerPixels = LayerMetadata & {
  pixels: Uint8ClampedArray;
};

export type ProjectSaveState = {
  width: number;
  height: number;
  activeLayerId: LayerId | null;
  view: {
    zoom: number;
    offsetX: number;
    offsetY: number;
  };
  brush: {
    color: string;
    size: number;
  };
  layers: ProjectLayerPixels[];
};

export type DecodedProjectLayer = {
  metadata: ProjectLayerManifest;
  pixels: Uint8ClampedArray;
};

export type DecodedProject = {
  manifest: ProjectManifest;
  layers: DecodedProjectLayer[];
};

function makeLayerImagePath(index: number, id: LayerId) {
  return `layers/${String(index).padStart(3, "0")}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
}

export async function createProjectBlob(state: ProjectSaveState) {
  const entries: ZipEntry[] = [];
  const projectLayers: ProjectLayerManifest[] = [];

  for (let i = 0; i < state.layers.length; i++) {
    const layer = state.layers[i];
    const image = makeLayerImagePath(i, layer.id);
    const pixels = new Uint8ClampedArray(layer.pixels);
    unpremultiplyPixels(pixels);
    const png = await pixelsToPngBlob(pixels, state.width, state.height);
    entries.push({ path: image, data: await blobToBytes(png) });
    projectLayers.push({
      id: layer.id,
      name: layer.name,
      image,
      visible: layer.visible,
      locked: layer.locked,
    });
  }

  const manifest: ProjectManifest = {
    format: "minipaint-project",
    version: 1,
    canvas: {
      width: state.width,
      height: state.height,
      background: "#ffffff",
      colorSpace: "srgb",
    },
    activeLayerId: state.activeLayerId,
    view: state.view,
    brush: state.brush,
    layers: projectLayers,
  };

  entries.unshift({
    path: "manifest.json",
    data: textEncoder.encode(JSON.stringify(manifest, null, 2)),
  });

  return createZipBlob(entries);
}

export async function decodeProjectBlob(blob: Blob): Promise<DecodedProject> {
  const entries = await readZipEntries(blob);
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error("Invalid project file: manifest.json is missing.");

  const manifest = parseProjectManifest(JSON.parse(textDecoder.decode(manifestBytes)));
  const layers: DecodedProjectLayer[] = [];

  for (const layerManifest of manifest.layers) {
    const imageBytes = entries.get(layerManifest.image);
    if (!imageBytes) throw new Error(`Invalid project file: ${layerManifest.image} is missing.`);

    const pixels = await pngBlobToPixels(
      bytesToBlob(imageBytes, "image/png"),
      manifest.canvas.width,
      manifest.canvas.height,
    );
    premultiplyPixels(pixels);
    layers.push({ metadata: layerManifest, pixels });
  }

  return { manifest, layers };
}
