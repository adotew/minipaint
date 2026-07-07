import type { LayerId, LayerMetadata } from "../core/types";
import type { GpuPaintRenderer } from "../gpu/paintRenderer";
import { applyLayerMetadata, captureLayerMetadata, createLayerList, getNextLayerNumber, type LayerListItem, type PaintLayer } from "./layers";
import { HistoryManager, type HistoryEntry, type LayerAddHistoryEntry } from "./history";

export class PaintDocumentController {
  layers: PaintLayer[] = [];
  activeLayerId: LayerId | null = null;
  history = new HistoryManager();
  private nextLayerNumber = 1;

  constructor(private renderer: GpuPaintRenderer) {}

  get layerList(): LayerListItem[] {
    return createLayerList(this.layers, this.activeLayerId);
  }

  get activeLayer() {
    return this.layers.find((layer) => layer.id === this.activeLayerId) ?? null;
  }

  get canUndo() {
    return this.history.canUndo;
  }

  get canRedo() {
    return this.history.canRedo;
  }

  setInitialLayer(layer: PaintLayer) {
    this.replaceLayers([layer], layer.id);
    this.nextLayerNumber = 2;
  }

  clearHistory() {
    this.history.clear();
  }

  createLayer(metadata: Partial<LayerMetadata> | undefined = undefined, sourcePixels: GPUTexture | undefined = undefined) {
    const fallbackName = metadata?.name ?? `Layer ${this.nextLayerNumber++}`;
    return this.renderer.createLayer(metadata, fallbackName, sourcePixels);
  }

  destroyLayer(layer: PaintLayer) {
    this.renderer.destroyLayer(layer);
  }

  replaceLayers(nextLayers: PaintLayer[], nextActiveLayerId: LayerId | null) {
    for (const layer of this.layers) {
      this.destroyLayer(layer);
    }

    this.layers = nextLayers;
    this.activeLayerId = nextActiveLayerId && this.layers.some((layer) => layer.id === nextActiveLayerId)
      ? nextActiveLayerId
      : this.layers[this.layers.length - 1]?.id ?? null;
    this.renderer.markCompositeDirty();
  }

  updateNextLayerNumber() {
    this.nextLayerNumber = getNextLayerNumber(this.layers);
  }

  addLayer() {
    const activeIndex = this.layers.findIndex((layer) => layer.id === this.activeLayerId);
    const index = activeIndex >= 0 ? activeIndex + 1 : this.layers.length;
    const activeBefore = this.activeLayerId;
    const layer = this.createLayer();
    this.layers.splice(index, 0, layer);
    this.activeLayerId = layer.id;
    this.renderer.markCompositeDirty();
    this.history.push({
      kind: "layer-add",
      layerId: layer.id,
      index,
      metadata: captureLayerMetadata(layer),
      activeBefore,
      activeAfter: layer.id,
    });
  }

  deleteLayer(layerId: LayerId) {
    if (this.layers.length <= 1 || !this.activeLayerId) return;

    const index = this.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) return;

    const activeBefore = this.activeLayerId;
    const [layer] = this.layers.splice(index, 1);
    const pixels = this.renderer.copyTexture(layer.texture, "Deleted layer snapshot");
    const metadata = captureLayerMetadata(layer);
    const activeAfter = activeBefore === metadata.id
      ? this.layers[Math.min(index, this.layers.length - 1)]?.id ?? null
      : activeBefore;
    this.destroyLayer(layer);
    this.activeLayerId = activeAfter;
    this.renderer.markCompositeDirty();
    this.history.push({
      kind: "layer-delete",
      layerId: metadata.id,
      index,
      metadata,
      pixels,
      activeBefore,
      activeAfter,
    });
  }

  setActiveLayer(id: LayerId) {
    if (!this.layers.some((layer) => layer.id === id)) return;
    this.activeLayerId = id;
  }

  setLayerOrder(topToBottomIds: LayerId[]) {
    if (topToBottomIds.length !== this.layers.length) return;

    const currentIds = new Set(this.layers.map((layer) => layer.id));
    if (!topToBottomIds.every((id) => currentIds.has(id))) return;

    const beforeOrder = this.layers.map((layer) => layer.id);
    const afterOrder = topToBottomIds.slice().reverse();
    if (beforeOrder.join("\0") === afterOrder.join("\0")) return;

    this.reorderLayerStack(afterOrder);
    this.renderer.markCompositeDirty();
    this.history.push({
      kind: "layer-reorder",
      beforeOrder,
      afterOrder,
      activeBefore: this.activeLayerId,
      activeAfter: this.activeLayerId,
    });
  }

  updateLayerMetadata(id: LayerId, update: (layer: PaintLayer) => void) {
    const layer = this.layers.find((item) => item.id === id);
    if (!layer) return;

    const before = captureLayerMetadata(layer);
    update(layer);
    const after = captureLayerMetadata(layer);
    if (JSON.stringify(before) === JSON.stringify(after)) return;

    this.renderer.markCompositeDirty();
    this.history.push({ kind: "layer-metadata", layerId: id, before, after });
  }

  undo() {
    const entry = this.history.takeUndoEntry();
    if (!entry) return;
    this.applyUndo(entry);
  }

  redo() {
    const entry = this.history.takeRedoEntry();
    if (!entry) return;
    this.applyRedo(entry);
  }

  dispose() {
    for (const layer of this.layers) {
      this.destroyLayer(layer);
    }
    this.layers = [];
    this.activeLayerId = null;
    this.history.clear();
  }

  private restoreLayerAdd(entry: LayerAddHistoryEntry) {
    const index = Math.min(entry.index, this.layers.length);
    this.layers.splice(index, 0, this.createLayer(entry.metadata));
    this.activeLayerId = entry.activeAfter;
  }

  private reorderLayerStack(order: LayerId[]) {
    const byId = new Map(this.layers.map((layer) => [layer.id, layer]));
    this.layers = order
      .map((id) => byId.get(id))
      .filter((layer): layer is PaintLayer => Boolean(layer));
  }

  private removeLayerById(layerId: LayerId) {
    const index = this.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) return;
    const [layer] = this.layers.splice(index, 1);
    this.destroyLayer(layer);
  }

  private applyUndo(entry: HistoryEntry) {
    if (entry.kind === "paint") {
      const layer = this.layers.find((item) => item.id === entry.layerId);
      if (!layer) return;
      entry.redo?.destroy();
      entry.redo = this.renderer.copyTexture(layer.texture, "Paint redo snapshot");
      this.renderer.restoreTexture(layer.texture, entry.before);
      this.activeLayerId = entry.layerId;
    } else if (entry.kind === "layer-metadata") {
      const layer = this.layers.find((item) => item.id === entry.layerId);
      if (layer) applyLayerMetadata(layer, entry.before);
    } else if (entry.kind === "layer-add") {
      this.removeLayerById(entry.layerId);
      this.activeLayerId = entry.activeBefore;
    } else if (entry.kind === "layer-delete") {
      const index = Math.min(entry.index, this.layers.length);
      this.layers.splice(index, 0, this.createLayer(entry.metadata, entry.pixels));
      this.activeLayerId = entry.activeBefore;
    } else if (entry.kind === "layer-reorder") {
      this.reorderLayerStack(entry.beforeOrder);
      this.activeLayerId = entry.activeBefore;
    }

    this.renderer.markCompositeDirty();
  }

  private applyRedo(entry: HistoryEntry) {
    if (entry.kind === "paint") {
      const layer = this.layers.find((item) => item.id === entry.layerId);
      if (!layer || !entry.redo) return;
      this.renderer.restoreTexture(layer.texture, entry.redo);
      this.activeLayerId = entry.layerId;
    } else if (entry.kind === "layer-metadata") {
      const layer = this.layers.find((item) => item.id === entry.layerId);
      if (layer) applyLayerMetadata(layer, entry.after);
    } else if (entry.kind === "layer-add") {
      this.restoreLayerAdd(entry);
    } else if (entry.kind === "layer-delete") {
      this.removeLayerById(entry.layerId);
      this.activeLayerId = entry.activeAfter;
    } else if (entry.kind === "layer-reorder") {
      this.reorderLayerStack(entry.afterOrder);
      this.activeLayerId = entry.activeAfter;
    }

    this.renderer.markCompositeDirty();
  }
}
