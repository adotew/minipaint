import type { LayerId, LayerMetadata } from "../core/types";

export type PaintLayer = LayerMetadata & {
  texture: GPUTexture;
  view: GPUTextureView;
  compositeBindGroup: GPUBindGroup;
};

export type LayerListItem = LayerMetadata & {
  active: boolean;
};

export function makeLayerId(): LayerId {
  return `layer-${crypto.randomUUID()}`;
}

export function captureLayerMetadata(layer: PaintLayer): LayerMetadata {
  return {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
  };
}

export function applyLayerMetadata(layer: PaintLayer, metadata: LayerMetadata) {
  layer.name = metadata.name;
  layer.visible = metadata.visible;
  layer.locked = metadata.locked;
}

export function createLayerList(layers: PaintLayer[], activeLayerId: LayerId | null): LayerListItem[] {
  return layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    active: layer.id === activeLayerId,
  }));
}

export function getNextLayerNumber(layers: PaintLayer[]) {
  let maxLayerNumber = 0;
  for (const layer of layers) {
    const match = /^Layer (\d+)$/.exec(layer.name);
    if (match) maxLayerNumber = Math.max(maxLayerNumber, Number(match[1]));
  }
  return Math.max(maxLayerNumber + 1, layers.length + 1);
}
