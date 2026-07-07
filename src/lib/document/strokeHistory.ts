import type { LayerId } from "../core/types";
import type { HistoryManager } from "./history";

export class StrokeHistoryManager {
  private current: { layerId: LayerId; before: GPUTexture } | null = null;
  private hadPaint = false;
  private saveAfterFrame = false;

  get shouldSaveAfterFrame() {
    return this.saveAfterFrame;
  }

  begin(layerId: LayerId, before: GPUTexture) {
    this.current?.before.destroy();
    this.current = { layerId, before };
    this.hadPaint = false;
    this.saveAfterFrame = false;
  }

  markPainted() {
    this.hadPaint = true;
  }

  requestSaveAfterFrame() {
    this.saveAfterFrame = true;
  }

  resetPaintTracking() {
    this.hadPaint = false;
    this.saveAfterFrame = false;
  }

  finalize(history: HistoryManager) {
    if (!this.saveAfterFrame) return;

    if (this.current && this.hadPaint) {
      history.push({
        kind: "paint",
        layerId: this.current.layerId,
        before: this.current.before,
        redo: null,
      });
    } else {
      this.current?.before.destroy();
    }

    this.current = null;
    this.hadPaint = false;
    this.saveAfterFrame = false;
  }

  clear() {
    this.current?.before.destroy();
    this.current = null;
    this.hadPaint = false;
    this.saveAfterFrame = false;
  }
}
