import { MAX_HISTORY_DEPTH } from "../core/constants";
import type { LayerId, LayerMetadata } from "../core/types";

export type PaintHistoryEntry = {
  kind: "paint";
  layerId: LayerId;
  before: GPUTexture;
  redo: GPUTexture | null;
};

export type LayerMetadataHistoryEntry = {
  kind: "layer-metadata";
  layerId: LayerId;
  before: LayerMetadata;
  after: LayerMetadata;
};

export type LayerAddHistoryEntry = {
  kind: "layer-add";
  layerId: LayerId;
  index: number;
  metadata: LayerMetadata;
  activeBefore: LayerId | null;
  activeAfter: LayerId;
};

export type LayerDeleteHistoryEntry = {
  kind: "layer-delete";
  layerId: LayerId;
  index: number;
  metadata: LayerMetadata;
  pixels: GPUTexture;
  activeBefore: LayerId;
  activeAfter: LayerId | null;
};

export type LayerReorderHistoryEntry = {
  kind: "layer-reorder";
  beforeOrder: LayerId[];
  afterOrder: LayerId[];
  activeBefore: LayerId | null;
  activeAfter: LayerId | null;
};

export type HistoryEntry =
  | PaintHistoryEntry
  | LayerMetadataHistoryEntry
  | LayerAddHistoryEntry
  | LayerDeleteHistoryEntry
  | LayerReorderHistoryEntry;

export function destroyHistoryEntry(entry: HistoryEntry) {
  if (entry.kind === "paint") {
    entry.before.destroy();
    entry.redo?.destroy();
    return;
  }

  if (entry.kind === "layer-delete") {
    entry.pixels.destroy();
  }
}

export class HistoryManager {
  entries: HistoryEntry[] = [];
  index = -1;

  get canUndo() {
    return this.index >= 0;
  }

  get canRedo() {
    return this.index < this.entries.length - 1;
  }

  clear() {
    for (const entry of this.entries) {
      destroyHistoryEntry(entry);
    }
    this.entries = [];
    this.index = -1;
  }

  push(entry: HistoryEntry) {
    while (this.entries.length > this.index + 1) {
      const discarded = this.entries.pop();
      if (discarded) destroyHistoryEntry(discarded);
    }

    this.entries.push(entry);
    this.index++;

    while (this.entries.length > MAX_HISTORY_DEPTH) {
      const discarded = this.entries.shift();
      if (discarded) destroyHistoryEntry(discarded);
      this.index--;
    }
  }

  takeUndoEntry() {
    if (!this.canUndo) return null;
    const entry = this.entries[this.index];
    this.index--;
    return entry;
  }

  takeRedoEntry() {
    if (!this.canRedo) return null;
    this.index++;
    return this.entries[this.index];
  }
}
