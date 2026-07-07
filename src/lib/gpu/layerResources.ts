import type { LayerMetadata } from "../core/types";
import { makeLayerId, type PaintLayer } from "../document/layers";
import { clearTexture, createDocumentTexture, restoreTexture } from "./textures";

export function createPaintLayerResource(options: {
  device: GPUDevice;
  width: number;
  height: number;
  compositeBindGroupLayout: GPUBindGroupLayout;
  compositeSampler: GPUSampler;
  metadata?: Partial<LayerMetadata>;
  fallbackName: string;
  sourcePixels?: GPUTexture;
}) {
  const layerId = options.metadata?.id ?? makeLayerId();
  const texture = createDocumentTexture(options.device, options.width, options.height, `Paint layer ${layerId}`);
  const view = texture.createView();
  const compositeBindGroup = options.device.createBindGroup({
    layout: options.compositeBindGroupLayout,
    entries: [
      { binding: 0, resource: options.compositeSampler },
      { binding: 1, resource: view },
    ],
  });

  const layer: PaintLayer = {
    id: layerId,
    name: options.metadata?.name ?? options.fallbackName,
    texture,
    view,
    compositeBindGroup,
    visible: options.metadata?.visible ?? true,
    locked: options.metadata?.locked ?? false,
  };

  if (options.sourcePixels) {
    restoreTexture(options.device, texture, options.sourcePixels, options.width, options.height);
  } else {
    clearTexture(options.device, texture, [0, 0, 0, 0]);
  }

  return layer;
}

export function destroyPaintLayerResource(layer: PaintLayer) {
  layer.texture.destroy();
}
