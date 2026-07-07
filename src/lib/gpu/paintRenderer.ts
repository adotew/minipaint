import { MAX_STAMPS_PER_FRAME } from "../core/constants";
import type { Rgba } from "../core/color";
import type { LayerMetadata, ToolMode } from "../core/types";
import type { PaintLayer } from "../document/layers";
import { pixelsToPngBlob } from "../persistence/png";
import { createCompositeTextureResources } from "./compositeResources";
import { createPaintLayerResource, destroyPaintLayerResource } from "./layerResources";
import { premultipliedRgbaToHex, readTexturePixel } from "./readback";
import {
  blitCompositeToViewport,
  rebuildComposite,
  renderStamps,
  writeViewUniforms,
} from "./rendering";
import { createSmudgeBindGroup } from "./pipelines";
import type { GpuCanvasResources } from "./rendererSetup";
import { createDocumentTexture, copyTexture, readTexturePixels, restoreTexture, uploadTexturePixels } from "./textures";
import { StampQueue } from "../input/stampQueue";

export type RendererViewState = {
  cssWidth: number;
  cssHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
};

export type GpuPaintRendererCallbacks = {
  getLayers: () => PaintLayer[];
  getActiveLayer: () => PaintLayer | null;
  onPaintRendered: () => void;
  onFrameComplete: () => void;
};

export class GpuPaintRenderer {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly initialLayer: PaintLayer;

  documentWidth: number;
  documentHeight: number;

  private compositeTexture: GPUTexture;
  private compositeTextureView: GPUTextureView;
  private brushStampTexture: GPUTexture;
  private brushStampTextureView: GPUTextureView;
  private brushSampler: GPUSampler;
  private stampBuffer: GPUBuffer;
  private stampUniformBuffer: GPUBuffer;
  private viewUniformBuffer: GPUBuffer;
  private eyedropperReadBuffer: GPUBuffer;
  private stampPipeline: GPURenderPipeline;
  private eraserStampPipeline: GPURenderPipeline;
  private smudgePipeline: GPURenderPipeline;
  private smudgeBindGroupLayout: GPUBindGroupLayout;
  private compositePipeline: GPURenderPipeline;
  private renderPipeline: GPURenderPipeline;
  private stampBindGroup: GPUBindGroup;
  private renderBindGroup: GPUBindGroup;
  private renderBindGroupLayout: GPUBindGroupLayout;
  private paintSampler: GPUSampler;
  private compositeBindGroupLayout: GPUBindGroupLayout;
  private compositeSampler: GPUSampler;
  private smudgeSourceTexture: GPUTexture | null = null;
  private smudgeBindGroup: GPUBindGroup | null = null;
  private stampDataView: Float32Array;
  private stampQueue = new StampQueue();
  private rafId: number | null = null;
  private compositeDirty = true;
  private viewState: RendererViewState;

  constructor(
    resources: GpuCanvasResources,
    documentWidth: number,
    documentHeight: number,
    private callbacks: GpuPaintRendererCallbacks,
  ) {
    this.device = resources.device;
    this.context = resources.context;
    this.initialLayer = resources.initialLayer;
    this.documentWidth = documentWidth;
    this.documentHeight = documentHeight;
    this.compositeTexture = resources.compositeTexture;
    this.compositeTextureView = resources.compositeTextureView;
    this.brushStampTexture = resources.brushStampTexture;
    this.brushStampTextureView = resources.brushStampTextureView;
    this.brushSampler = resources.brushSampler;
    this.stampBuffer = resources.stampBuffer;
    this.stampUniformBuffer = resources.stampUniformBuffer;
    this.viewUniformBuffer = resources.viewUniformBuffer;
    this.eyedropperReadBuffer = resources.eyedropperReadBuffer;
    this.stampPipeline = resources.stampPipeline;
    this.eraserStampPipeline = resources.eraserStampPipeline;
    this.smudgePipeline = resources.smudgePipeline;
    this.smudgeBindGroupLayout = resources.smudgeBindGroupLayout;
    this.compositePipeline = resources.compositePipeline;
    this.renderPipeline = resources.renderPipeline;
    this.stampBindGroup = resources.stampBindGroup;
    this.renderBindGroup = resources.renderBindGroup;
    this.renderBindGroupLayout = resources.renderBindGroupLayout;
    this.paintSampler = resources.paintSampler;
    this.compositeBindGroupLayout = resources.compositeBindGroupLayout;
    this.compositeSampler = resources.compositeSampler;
    this.stampDataView = resources.stampDataView;
    this.viewState = {
      cssWidth: 0,
      cssHeight: 0,
      canvasWidth: 0,
      canvasHeight: 0,
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
    };
  }

  get pendingStampCount() {
    return this.stampQueue.length;
  }

  get stampDistanceSinceLastStamp() {
    return this.stampQueue.distanceSinceLastStamp;
  }

  set stampDistanceSinceLastStamp(value: number) {
    this.stampQueue.distanceSinceLastStamp = value;
  }

  setViewState(state: RendererViewState) {
    this.viewState = state;
  }

  setViewportSize(canvasWidth: number, canvasHeight: number) {
    this.viewState = { ...this.viewState, canvasWidth, canvasHeight };
  }

  markCompositeDirty() {
    this.compositeDirty = true;
  }

  createLayer(metadata?: Partial<LayerMetadata>, fallbackName = "Layer", sourcePixels?: GPUTexture) {
    return createPaintLayerResource({
      device: this.device,
      width: this.documentWidth,
      height: this.documentHeight,
      compositeBindGroupLayout: this.compositeBindGroupLayout,
      compositeSampler: this.compositeSampler,
      metadata,
      fallbackName,
      sourcePixels,
    });
  }

  destroyLayer(layer: PaintLayer) {
    destroyPaintLayerResource(layer);
  }

  copyTexture(source: GPUTexture, label: string) {
    return copyTexture(this.device, source, this.documentWidth, this.documentHeight, label);
  }

  restoreTexture(target: GPUTexture, snapshot: GPUTexture) {
    restoreTexture(this.device, target, snapshot, this.documentWidth, this.documentHeight);
  }

  uploadLayerPixels(layer: PaintLayer, pixels: Uint8ClampedArray) {
    uploadTexturePixels(this.device, layer.texture, pixels, this.documentWidth, this.documentHeight);
  }

  readLayerPixels(layer: PaintLayer) {
    return readTexturePixels(this.device, layer.texture, this.documentWidth, this.documentHeight);
  }

  resizeDocument(width: number, height: number) {
    this.cancelScheduledFrame();
    this.clearStamps();
    this.documentWidth = width;
    this.documentHeight = height;
    this.device.queue.writeBuffer(this.stampUniformBuffer, 0, new Float32Array([width, height, 0, 0]));

    const oldCompositeTexture = this.compositeTexture;
    const resources = createCompositeTextureResources({
      device: this.device,
      width,
      height,
      renderBindGroupLayout: this.renderBindGroupLayout,
      paintSampler: this.paintSampler,
      viewUniformBuffer: this.viewUniformBuffer,
    });
    this.compositeTexture = resources.texture;
    this.compositeTextureView = resources.view;
    this.renderBindGroup = resources.renderBindGroup;
    oldCompositeTexture.destroy();
    this.resetSmudgeSourceTexture();
    this.markCompositeDirty();
  }

  clearStamps() {
    this.stampQueue.clear();
  }

  private resetSmudgeSourceTexture() {
    this.smudgeSourceTexture?.destroy();
    this.smudgeSourceTexture = null;
    this.smudgeBindGroup = null;
  }

  private ensureSmudgeSourceTexture() {
    if (this.smudgeSourceTexture) return this.smudgeSourceTexture;

    this.smudgeSourceTexture = createDocumentTexture(
      this.device,
      this.documentWidth,
      this.documentHeight,
      "Smudge source texture",
    );
    this.smudgeBindGroup = createSmudgeBindGroup(
      this.device,
      this.smudgeBindGroupLayout,
      this.brushSampler,
      this.brushStampTextureView,
      this.stampBuffer,
      this.stampUniformBuffer,
      this.brushSampler,
      this.smudgeSourceTexture.createView(),
    );
    return this.smudgeSourceTexture;
  }

  beginSmudgeStroke(layer: PaintLayer, x: number, y: number) {
    this.stampQueue.beginSmudgeStroke(x, y);
    const smudgeSourceTexture = this.ensureSmudgeSourceTexture();
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: layer.texture },
      { texture: smudgeSourceTexture },
      [this.documentWidth, this.documentHeight, 1],
    );
    this.device.queue.submit([encoder.finish()]);
  }

  queueStamp(x: number, y: number, radius: number, rgba: Rgba, mode: ToolMode) {
    const queued = this.stampQueue.queueStamp(x, y, radius, rgba, mode, this.documentWidth, this.documentHeight);
    if (!queued) return false;

    this.scheduleFrame();
    return true;
  }

  stampLine(options: {
    x1: number;
    y1: number;
    r1: number;
    o1: number;
    x2: number;
    y2: number;
    r2: number;
    o2: number;
    rgba: Rgba;
    mode: ToolMode;
  }) {
    const queued = this.stampQueue.stampLine({
      ...options,
      documentWidth: this.documentWidth,
      documentHeight: this.documentHeight,
    });
    if (queued === 0) return false;

    this.scheduleFrame();
    return true;
  }

  scheduleFrame() {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => this.flushFrame());
  }

  cancelScheduledFrame() {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  flushPendingWork() {
    this.cancelScheduledFrame();

    const maxFlushes = Math.ceil(this.stampQueue.length / MAX_STAMPS_PER_FRAME) + 2;
    let flushes = 0;
    while (this.stampQueue.length > 0) {
      if (flushes > maxFlushes) {
        throw new Error("Could not flush pending paint data before export.");
      }
      this.flushFrame();
      this.cancelScheduledFrame();
      flushes++;
    }

    if (this.compositeDirty) {
      this.flushFrame();
      this.cancelScheduledFrame();
    }
  }

  flushFrame() {
    if (this.viewState.canvasWidth === 0 || this.viewState.canvasHeight === 0) {
      this.rafId = null;
      return;
    }

    const stamps = this.stampQueue.takeAll();
    const count = Math.min(stamps.length, MAX_STAMPS_PER_FRAME);
    if (stamps.length > count) {
      this.stampQueue.prepend(stamps.slice(count));
    }

    const encoder = this.device.createCommandEncoder();

    if (count > 0) {
      const rendered = renderStamps({
        encoder,
        device: this.device,
        stampBuffer: this.stampBuffer,
        stampDataView: this.stampDataView,
        stamps,
        count,
        documentWidth: this.documentWidth,
        documentHeight: this.documentHeight,
        activeLayer: this.callbacks.getActiveLayer(),
        stampPipeline: this.stampPipeline,
        eraserStampPipeline: this.eraserStampPipeline,
        smudgePipeline: this.smudgePipeline,
        stampBindGroup: this.stampBindGroup,
        smudgeBindGroup: this.smudgeBindGroup,
        smudgeSourceTexture: this.smudgeSourceTexture,
      });
      if (rendered) {
        this.callbacks.onPaintRendered();
        this.markCompositeDirty();
      }
    }

    if (this.compositeDirty) {
      rebuildComposite(
        encoder,
        this.compositeTextureView,
        this.compositePipeline,
        this.callbacks.getLayers(),
      );
      this.compositeDirty = false;
    }

    writeViewUniforms(this.device, this.viewUniformBuffer, {
      ...this.viewState,
      documentWidth: this.documentWidth,
      documentHeight: this.documentHeight,
    });
    blitCompositeToViewport(encoder, this.context, this.renderPipeline, this.renderBindGroup);

    this.device.queue.submit([encoder.finish()]);

    if (this.stampQueue.length > 0) {
      this.scheduleFrame();
      return;
    }

    this.callbacks.onFrameComplete();
    this.rafId = null;
  }

  async readCompositeAsPngBlob() {
    return await pixelsToPngBlob(
      await readTexturePixels(this.device, this.compositeTexture, this.documentWidth, this.documentHeight),
      this.documentWidth,
      this.documentHeight,
    );
  }

  async readCompositePixelAsHex(x: number, y: number) {
    const [r, g, b, a] = await readTexturePixel(
      this.device,
      this.compositeTexture,
      this.eyedropperReadBuffer,
      x,
      y,
    );
    return premultipliedRgbaToHex(r, g, b, a);
  }

  dispose() {
    this.cancelScheduledFrame();
    this.compositeTexture.destroy();
    this.resetSmudgeSourceTexture();
    this.brushStampTexture.destroy();
    this.stampBuffer.destroy();
    this.stampUniformBuffer.destroy();
    this.viewUniformBuffer.destroy();
    this.eyedropperReadBuffer.destroy();
    this.device.destroy();
  }
}
