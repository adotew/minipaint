<script lang="ts">
  /// <reference types="@webgpu/types" />

  import LayerPanel, { type LayerListItem } from "./LayerPanel.svelte";
  import stampShaderCode from "./shaders/stamp.wgsl?raw";
  import blitShaderCode from "./shaders/blit.wgsl?raw";
  import compositeShaderCode from "./shaders/composite.wgsl?raw";
  import brushStampUrl from "../assets/charcoal-removebg-preview.png";
  import brushStampOutlineUrl from "../assets/charcoal-removebg-preview.png";

  interface Props {
    color: string;
    brushSize: number;
  }

  let { color, brushSize = $bindable() }: Props = $props();

  type LayerId = string;

  type PaintLayer = {
    id: LayerId;
    name: string;
    texture: GPUTexture;
    view: GPUTextureView;
    compositeBindGroup: GPUBindGroup;
    visible: boolean;
    locked: boolean;
  };

  type LayerMetadata = {
    id: LayerId;
    name: string;
    visible: boolean;
    locked: boolean;
  };

  type PaintHistoryEntry = {
    kind: "paint";
    layerId: LayerId;
    before: GPUTexture;
    redo: GPUTexture | null;
  };

  type LayerMetadataHistoryEntry = {
    kind: "layer-metadata";
    layerId: LayerId;
    before: LayerMetadata;
    after: LayerMetadata;
  };

  type LayerAddHistoryEntry = {
    kind: "layer-add";
    layerId: LayerId;
    index: number;
    metadata: LayerMetadata;
    activeBefore: LayerId | null;
    activeAfter: LayerId;
  };

  type LayerDeleteHistoryEntry = {
    kind: "layer-delete";
    layerId: LayerId;
    index: number;
    metadata: LayerMetadata;
    pixels: GPUTexture;
    activeBefore: LayerId;
    activeAfter: LayerId | null;
  };

  type HistoryEntry =
    | PaintHistoryEntry
    | LayerMetadataHistoryEntry
    | LayerAddHistoryEntry
    | LayerDeleteHistoryEntry;

  const CANVAS_WIDTH = 4000;
  const CANVAS_HEIGHT = 4000;
  const MIN_ZOOM = 0.01;
  const MAX_ZOOM = 32;
  const MAX_STAMPS_PER_FRAME = 1024;
  const FLOATS_PER_STAMP = 12;
  const MIN_PRESSURE_SIZE = 0.45;
  const MIN_PRESSURE_OPACITY = 0.08;
  const PRESSURE_OPACITY_GAMMA = 1.35;
  const STAMP_SPACING_RATIO = 0.25;
  const MIN_STAMP_SPACING = 1;
  const BRUSH_STAMP_ASPECT = 500 / 500;
  const PRESSURE_FALLBACK = 0.5;
  const PRESSURE_EPSILON = 0.001;
  const MAX_HISTORY_DEPTH = 10;
  const BYTES_PER_PIXEL = 4;
  const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

  // ---- DOM binding ----
  let canvasEl: HTMLCanvasElement | undefined = $state();
  let error = $state<string | null>(null);

  // ---- zoom / pan state ----
  // zoom is CSS pixels per paint pixel. offset is the paint-space
  // coordinate currently shown at the viewport's top-left.
  let zoom = $state(1);
  let offsetX = $state(0);
  let offsetY = $state(0);
  let hasFitInitialView = false;
  let isPanning = $state(false);
  let isSpaceHeld = $state(false);

  // ---- image rendering hint ----
  let imageRenderHint = $derived(zoom < 1 ? "auto" : "pixelated");

  // ---- cursor ----
  let cursor = $derived(
    isPanning ? "grabbing" : isSpaceHeld ? "grab" : "none"
  );
  let brushPreviewVisible = $state(false);
  let brushPreviewX = $state(0);
  let brushPreviewY = $state(0);
  let brushPreviewRadius = $state(0);
  let brushPreviewWidth = $derived(Math.max(1, getStampHalfSize(brushPreviewRadius).halfWidth * 2 * zoom));
  let brushPreviewHeight = $derived(Math.max(1, getStampHalfSize(brushPreviewRadius).halfHeight * 2 * zoom));

  // ---- WebGPU refs ----
  let device: GPUDevice | null = $state(null);
  let context: GPUCanvasContext | null = $state(null);
  let compositeTexture: GPUTexture | null = $state(null);
  let compositeTextureView: GPUTextureView | null = $state(null);
  let brushStampTexture: GPUTexture | null = $state(null);
  let stampBuffer: GPUBuffer | null = $state(null);
  let stampUniformBuffer: GPUBuffer | null = $state(null);
  let viewUniformBuffer: GPUBuffer | null = $state(null);
  let stampPipeline: GPURenderPipeline | null = $state(null);
  let compositePipeline: GPURenderPipeline | null = $state(null);
  let renderPipeline: GPURenderPipeline | null = $state(null);
  let stampBindGroup: GPUBindGroup | null = $state(null);
  let renderBindGroup: GPUBindGroup | null = $state(null);
  let compositeBindGroupLayout: GPUBindGroupLayout | null = null;
  let compositeSampler: GPUSampler | null = null;

  // ---- layer state ----
  let layers: PaintLayer[] = [];
  let layerList = $state<LayerListItem[]>([]);
  let activeLayerId = $state<LayerId | null>(null);
  let compositeDirty = true;
  let nextLayerNumber = 1;

  // ---- undo / redo state ----
  let historyEntries: HistoryEntry[] = [];
  let historyIndex = -1;
  let shouldSaveHistoryAfterFrame = false;

  // ---- drawing state ----
  let isDrawing = false;
  let strokeUsesPressure = false;
  let lastPoint = { x: 0, y: 0, radius: 0, opacity: 1 };
  let distanceSinceLastStamp = 0;
  let currentStrokeHistory: { layerId: LayerId; before: GPUTexture } | null = null;
  let strokeHadPaint = false;

  // ---- brush resize state ----
  let isResizingBrush = false;
  let resizeStartY = 0;
  let resizeStartBrushSize = 0;

  // ---- pan tracking ----
  let panStart = { clientX: 0, clientY: 0, offsetX: 0, offsetY: 0 };

  // ---- wheel accumulator ----
  let wheelAccum = 0;

  // ---- pending stamps (batched per frame) ----
  type PendingStamp = {
    x: number;
    y: number;
    radius: number;
    rgba: [number, number, number, number];
  };
  let pendingStamps: PendingStamp[] = [];
  let rafId: number | null = null;

  // ---- current canvas internal size (set by ResizeObserver) ----
  let canvasWidth = $state(0);
  let canvasHeight = $state(0);

  // ---- per-frame CPU buffer for stamp data (avoid per-frame alloc) ----
  let stampDataView: Float32Array;

  // ====================================================================
  //  Helpers
  // ====================================================================

  function hexToVec4(hex: string): [number, number, number, number] {
    const clean = hex.replace("#", "");
    if (clean.length !== 6) return [0, 0, 0, 1];
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    return [r, g, b, 1];
  }

  function withAlpha(rgba: [number, number, number, number], alpha: number): [number, number, number, number] {
    return [rgba[0], rgba[1], rgba[2], alpha];
  }

  function lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
  }

  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
  }

  function alignTo(n: number, alignment: number) {
    return Math.ceil(n / alignment) * alignment;
  }

  function makeExportFilename() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `minipaint-${timestamp}.png`;
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function canvasToPngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Failed to encode PNG."));
        }
      }, "image/png");
    });
  }

  async function readTextureAsPngBlob(dev: GPUDevice, texture: GPUTexture) {
    const bytesPerRow = CANVAS_WIDTH * BYTES_PER_PIXEL;
    const paddedBytesPerRow = alignTo(bytesPerRow, COPY_BYTES_PER_ROW_ALIGNMENT);
    const bufferSize = paddedBytesPerRow * CANVAS_HEIGHT;
    const readBuffer = dev.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = dev.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      {
        buffer: readBuffer,
        bytesPerRow: paddedBytesPerRow,
        rowsPerImage: CANVAS_HEIGHT,
      },
      [CANVAS_WIDTH, CANVAS_HEIGHT, 1],
    );
    dev.queue.submit([encoder.finish()]);

    let isMapped = false;
    try {
      await readBuffer.mapAsync(GPUMapMode.READ);
      isMapped = true;

      const mapped = readBuffer.getMappedRange();
      const source = new Uint8Array(mapped);
      const pixels = new Uint8ClampedArray(CANVAS_WIDTH * CANVAS_HEIGHT * BYTES_PER_PIXEL);

      for (let y = 0; y < CANVAS_HEIGHT; y++) {
        const sourceOffset = y * paddedBytesPerRow;
        const targetOffset = y * bytesPerRow;
        pixels.set(source.subarray(sourceOffset, sourceOffset + bytesPerRow), targetOffset);
      }

      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = CANVAS_WIDTH;
      exportCanvas.height = CANVAS_HEIGHT;

      const ctx = exportCanvas.getContext("2d");
      if (!ctx) throw new Error("Could not create PNG export canvas.");

      ctx.putImageData(new ImageData(pixels, CANVAS_WIDTH, CANVAS_HEIGHT), 0, 0);
      return await canvasToPngBlob(exportCanvas);
    } finally {
      if (isMapped) readBuffer.unmap();
      readBuffer.destroy();
    }
  }

  function screenToCanvas(screenX: number, screenY: number) {
    return {
      x: screenX / zoom + offsetX,
      y: screenY / zoom + offsetY,
    };
  }

  function getStampHalfSize(radius: number) {
    if (BRUSH_STAMP_ASPECT >= 1) {
      return { halfWidth: radius, halfHeight: radius / BRUSH_STAMP_ASPECT };
    }

    return { halfWidth: radius * BRUSH_STAMP_ASPECT, halfHeight: radius };
  }

  function getStampSpacing(radius: number) {
    return Math.max(MIN_STAMP_SPACING, radius * STAMP_SPACING_RATIO);
  }

  function getStampBounds(x: number, y: number, radius: number) {
    const { halfWidth, halfHeight } = getStampHalfSize(radius);
    const minX = Math.max(0, Math.floor(x - halfWidth));
    const maxX = Math.min(CANVAS_WIDTH - 1, Math.ceil(x + halfWidth));
    const minY = Math.max(0, Math.floor(y - halfHeight));
    const maxY = Math.min(CANVAS_HEIGHT - 1, Math.ceil(y + halfHeight));

    return {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      halfWidth,
      halfHeight,
    };
  }

  async function loadBrushStampBitmap() {
    const response = await fetch(brushStampUrl);
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  // ====================================================================
  //  WebGPU helpers
  // ====================================================================

  function createDocumentTexture(dev: GPUDevice, label: string) {
    return dev.createTexture({
      label,
      size: [CANVAS_WIDTH, CANVAS_HEIGHT],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
  }

  function clearTexture(dev: GPUDevice, tex: GPUTexture, colorValue: GPUColor) {
    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: tex.createView(),
          loadOp: "clear",
          clearValue: colorValue,
          storeOp: "store",
        },
      ],
    });
    pass.end();
    dev.queue.submit([encoder.finish()]);
  }

  function copyTexture(dev: GPUDevice, source: GPUTexture, label: string) {
    const snapshot = createDocumentTexture(dev, label);
    const encoder = dev.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: source },
      { texture: snapshot },
      [CANVAS_WIDTH, CANVAS_HEIGHT],
    );
    dev.queue.submit([encoder.finish()]);
    return snapshot;
  }

  function restoreTexture(dev: GPUDevice, target: GPUTexture, snapshot: GPUTexture) {
    const encoder = dev.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: snapshot },
      { texture: target },
      [CANVAS_WIDTH, CANVAS_HEIGHT],
    );
    dev.queue.submit([encoder.finish()]);
  }

  function makeLayerId(): LayerId {
    return `layer-${crypto.randomUUID()}`;
  }

  function getActiveLayer() {
    return layers.find((layer) => layer.id === activeLayerId) ?? null;
  }

  function captureLayerMetadata(layer: PaintLayer): LayerMetadata {
    return {
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
    };
  }

  function applyLayerMetadata(layer: PaintLayer, metadata: LayerMetadata) {
    layer.name = metadata.name;
    layer.visible = metadata.visible;
    layer.locked = metadata.locked;
  }

  function createPaintLayer(
    dev: GPUDevice,
    metadata: Partial<LayerMetadata> | undefined = undefined,
    sourcePixels: GPUTexture | undefined = undefined,
  ) {
    if (!compositeBindGroupLayout || !compositeSampler) {
      throw new Error("Layer compositing is not ready.");
    }

    const layerId = metadata?.id ?? makeLayerId();
    const texture = createDocumentTexture(dev, `Paint layer ${layerId}`);
    const view = texture.createView();
    const compositeBindGroup = dev.createBindGroup({
      layout: compositeBindGroupLayout,
      entries: [
        { binding: 0, resource: compositeSampler },
        { binding: 1, resource: view },
      ],
    });

    const layer: PaintLayer = {
      id: layerId,
      name: metadata?.name ?? `Layer ${nextLayerNumber++}`,
      texture,
      view,
      compositeBindGroup,
      visible: metadata?.visible ?? true,
      locked: metadata?.locked ?? false,
    };

    if (sourcePixels) {
      restoreTexture(dev, texture, sourcePixels);
    } else {
      clearTexture(dev, texture, [0, 0, 0, 0]);
    }

    return layer;
  }

  function destroyLayer(layer: PaintLayer) {
    layer.texture.destroy();
  }

  function syncLayerList() {
    layerList = layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      active: layer.id === activeLayerId,
    }));
  }

  function markCompositeDirty() {
    compositeDirty = true;
  }

  function destroyHistoryEntry(entry: HistoryEntry) {
    if (entry.kind === "paint") {
      entry.before.destroy();
      entry.redo?.destroy();
      return;
    }

    if (entry.kind === "layer-delete") {
      entry.pixels.destroy();
    }
  }

  function pushHistoryEntry(entry: HistoryEntry) {
    while (historyEntries.length > historyIndex + 1) {
      const discarded = historyEntries.pop();
      if (discarded) destroyHistoryEntry(discarded);
    }

    historyEntries.push(entry);
    historyIndex++;

    while (historyEntries.length > MAX_HISTORY_DEPTH) {
      const discarded = historyEntries.shift();
      if (discarded) destroyHistoryEntry(discarded);
      historyIndex--;
    }
  }

  function finalizePendingPaintHistory() {
    if (!shouldSaveHistoryAfterFrame) return;

    if (currentStrokeHistory && strokeHadPaint) {
      pushHistoryEntry({
        kind: "paint",
        layerId: currentStrokeHistory.layerId,
        before: currentStrokeHistory.before,
        redo: null,
      });
    } else {
      currentStrokeHistory?.before.destroy();
    }

    currentStrokeHistory = null;
    strokeHadPaint = false;
    shouldSaveHistoryAfterFrame = false;
  }

  function resetInteractionState() {
    isDrawing = false;
    isPanning = false;
    isResizingBrush = false;
    strokeUsesPressure = false;
    distanceSinceLastStamp = 0;
  }

  function restoreLayerAdd(entry: LayerAddHistoryEntry) {
    const index = Math.min(entry.index, layers.length);
    layers.splice(index, 0, createPaintLayer(device!, entry.metadata));
    activeLayerId = entry.activeAfter;
  }

  function removeLayerById(layerId: LayerId) {
    const index = layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) return;
    const [layer] = layers.splice(index, 1);
    destroyLayer(layer);
  }

  function applyUndo(entry: HistoryEntry) {
    if (!device) return;

    if (entry.kind === "paint") {
      const layer = layers.find((item) => item.id === entry.layerId);
      if (!layer) return;
      entry.redo?.destroy();
      entry.redo = copyTexture(device, layer.texture, "Paint redo snapshot");
      restoreTexture(device, layer.texture, entry.before);
      activeLayerId = entry.layerId;
    } else if (entry.kind === "layer-metadata") {
      const layer = layers.find((item) => item.id === entry.layerId);
      if (layer) applyLayerMetadata(layer, entry.before);
    } else if (entry.kind === "layer-add") {
      removeLayerById(entry.layerId);
      activeLayerId = entry.activeBefore;
    } else if (entry.kind === "layer-delete") {
      const index = Math.min(entry.index, layers.length);
      layers.splice(index, 0, createPaintLayer(device, entry.metadata, entry.pixels));
      activeLayerId = entry.activeBefore;
    }

    syncLayerList();
    markCompositeDirty();
  }

  function applyRedo(entry: HistoryEntry) {
    if (!device) return;

    if (entry.kind === "paint") {
      const layer = layers.find((item) => item.id === entry.layerId);
      if (!layer || !entry.redo) return;
      restoreTexture(device, layer.texture, entry.redo);
      activeLayerId = entry.layerId;
    } else if (entry.kind === "layer-metadata") {
      const layer = layers.find((item) => item.id === entry.layerId);
      if (layer) applyLayerMetadata(layer, entry.after);
    } else if (entry.kind === "layer-add") {
      restoreLayerAdd(entry);
    } else if (entry.kind === "layer-delete") {
      removeLayerById(entry.layerId);
      activeLayerId = entry.activeAfter;
    }

    syncLayerList();
    markCompositeDirty();
  }

  export function undo() {
    if (!device || historyIndex < 0) return;

    flushPendingWorkForExport();
    resetInteractionState();

    applyUndo(historyEntries[historyIndex]);
    historyIndex--;
    scheduleFrame();
  }

  export function redo() {
    if (!device || historyIndex >= historyEntries.length - 1) return;

    flushPendingWorkForExport();
    resetInteractionState();

    historyIndex++;
    applyRedo(historyEntries[historyIndex]);
    scheduleFrame();
  }

  export function addLayer() {
    if (!device) return;

    const activeIndex = layers.findIndex((layer) => layer.id === activeLayerId);
    const index = activeIndex >= 0 ? activeIndex + 1 : layers.length;
    const activeBefore = activeLayerId;
    const layer = createPaintLayer(device);
    layers.splice(index, 0, layer);
    activeLayerId = layer.id;
    syncLayerList();
    markCompositeDirty();
    pushHistoryEntry({
      kind: "layer-add",
      layerId: layer.id,
      index,
      metadata: captureLayerMetadata(layer),
      activeBefore,
      activeAfter: layer.id,
    });
    scheduleFrame();
  }

  export function deleteLayer(layerId: LayerId) {
    if (!device || layers.length <= 1 || !activeLayerId) return;

    const index = layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) return;

    const activeBefore = activeLayerId;
    const [layer] = layers.splice(index, 1);
    const pixels = copyTexture(device, layer.texture, "Deleted layer snapshot");
    const metadata = captureLayerMetadata(layer);
    const activeAfter = activeBefore === metadata.id
      ? layers[Math.min(index, layers.length - 1)]?.id ?? null
      : activeBefore;
    destroyLayer(layer);
    activeLayerId = activeAfter;
    syncLayerList();
    markCompositeDirty();
    pushHistoryEntry({
      kind: "layer-delete",
      layerId: metadata.id,
      index,
      metadata,
      pixels,
      activeBefore,
      activeAfter,
    });
    scheduleFrame();
  }

  export function setActiveLayer(id: LayerId) {
    if (!layers.some((layer) => layer.id === id)) return;
    activeLayerId = id;
    syncLayerList();
  }

  function updateLayerMetadata(id: LayerId, update: (layer: PaintLayer) => void) {
    const layer = layers.find((item) => item.id === id);
    if (!layer) return;

    const before = captureLayerMetadata(layer);
    update(layer);
    const after = captureLayerMetadata(layer);
    if (JSON.stringify(before) === JSON.stringify(after)) return;

    syncLayerList();
    markCompositeDirty();
    pushHistoryEntry({ kind: "layer-metadata", layerId: id, before, after });
    scheduleFrame();
  }

  export function setLayerVisible(id: LayerId, visible: boolean) {
    updateLayerMetadata(id, (layer) => {
      layer.visible = visible;
    });
  }

  export function setLayerName(id: LayerId, name: string) {
    updateLayerMetadata(id, (layer) => {
      layer.name = name.trim() || layer.name;
    });
  }

  export function setLayerLocked(id: LayerId, locked: boolean) {
    updateLayerMetadata(id, (layer) => {
      layer.locked = locked;
    });
  }

  function cancelScheduledFrame() {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  function flushPendingWorkForExport() {
    cancelScheduledFrame();

    const maxFlushes = Math.ceil(pendingStamps.length / MAX_STAMPS_PER_FRAME) + 2;
    let flushes = 0;
    while (pendingStamps.length > 0) {
      if (flushes > maxFlushes) {
        throw new Error("Could not flush pending paint data before export.");
      }
      flushFrame();
      cancelScheduledFrame();
      flushes++;
    }

    if (shouldSaveHistoryAfterFrame || compositeDirty) {
      flushFrame();
      cancelScheduledFrame();
    }
  }

  export async function exportAsPng() {
    if (!device || !compositeTexture) {
      throw new Error("Canvas is not ready to export yet.");
    }

    flushPendingWorkForExport();
    const blob = await readTextureAsPngBlob(device, compositeTexture);
    downloadBlob(blob, makeExportFilename());
  }

  function rebuildComposite(encoder: GPUCommandEncoder) {
    if (!compositeTextureView || !compositePipeline) return;

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: compositeTextureView,
          loadOp: "clear",
          clearValue: [1, 1, 1, 1],
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(compositePipeline);
    for (const layer of layers) {
      if (!layer.visible) continue;
      pass.setBindGroup(0, layer.compositeBindGroup);
      pass.draw(3);
    }
    pass.end();

    compositeDirty = false;
  }

  function blitCompositeToViewport(encoder: GPUCommandEncoder) {
    if (!context || !renderPipeline || !renderBindGroup) return;

    writeViewUniforms(device!);

    const textureView = context.getCurrentTexture().createView();
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          loadOp: "clear",
          clearValue: [0.5, 0.5, 0.5, 1],
          storeOp: "store",
        },
      ],
    });
    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, renderBindGroup);
    renderPass.draw(3);
    renderPass.end();
  }

  function writeStampData(stamps: PendingStamp[], count: number) {
    for (let i = 0; i < count; i++) {
      const stamp = stamps[i];
      const { minX, maxX, minY, maxY, halfWidth, halfHeight } = getStampBounds(stamp.x, stamp.y, stamp.radius);

      const offset = i * FLOATS_PER_STAMP;
      stampDataView[offset + 0] = stamp.x;
      stampDataView[offset + 1] = stamp.y;
      stampDataView[offset + 2] = halfWidth;
      stampDataView[offset + 3] = halfHeight;
      stampDataView[offset + 4] = stamp.rgba[0];
      stampDataView[offset + 5] = stamp.rgba[1];
      stampDataView[offset + 6] = stamp.rgba[2];
      stampDataView[offset + 7] = stamp.rgba[3];
      stampDataView[offset + 8] = minX;
      stampDataView[offset + 9] = minY;
      stampDataView[offset + 10] = maxX;
      stampDataView[offset + 11] = maxY;
    }
  }

  /**
   * Process queued stamps into the active layer, composite visible layers, then
   * blit the composite texture to the visible canvas.
   */
  function flushFrame() {
    if (
      !device ||
      !context ||
      !compositeTexture ||
      !stampBuffer ||
      !viewUniformBuffer ||
      !stampPipeline ||
      !compositePipeline ||
      !renderPipeline ||
      !stampBindGroup ||
      !renderBindGroup
    ) {
      rafId = null;
      return;
    }

    if (canvasWidth === 0 || canvasHeight === 0) {
      rafId = null;
      return;
    }

    const stamps = pendingStamps;
    const n = stamps.length;
    pendingStamps = [];

    const encoder = device.createCommandEncoder();

    if (n > 0) {
      const activeLayer = getActiveLayer();
      const count = Math.min(n, MAX_STAMPS_PER_FRAME);
      if (n > count) {
        pendingStamps = stamps.slice(count).concat(pendingStamps);
      }

      if (activeLayer && activeLayer.visible && !activeLayer.locked) {
        writeStampData(stamps, count);
        device.queue.writeBuffer(stampBuffer, 0, stampDataView, 0, count * FLOATS_PER_STAMP);

        const stampPass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: activeLayer.view,
              loadOp: "load",
              storeOp: "store",
            },
          ],
        });
        stampPass.setPipeline(stampPipeline);
        stampPass.setBindGroup(0, stampBindGroup);
        stampPass.draw(6, count);
        stampPass.end();

        markCompositeDirty();
      }
    }

    if (compositeDirty) rebuildComposite(encoder);
    blitCompositeToViewport(encoder);

    device.queue.submit([encoder.finish()]);

    if (pendingStamps.length > 0) {
      scheduleFrame();
      return;
    }

    finalizePendingPaintHistory();
    rafId = null;
  }

  function writeViewUniforms(dev: GPUDevice) {
    const cssWidth = canvasEl?.clientWidth ?? canvasWidth;
    const cssHeight = canvasEl?.clientHeight ?? canvasHeight;

    const viewUniforms = new Float32Array([
      cssWidth / (canvasWidth * zoom),
      cssHeight / (canvasHeight * zoom),
      offsetX,
      offsetY,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      0, 0, // padding to 32 bytes (16-byte alignment)
    ]);
    dev.queue.writeBuffer(viewUniformBuffer!, 0, viewUniforms);
  }

  function scheduleFrame() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(flushFrame);
  }

  function queueStamp(
    x: number,
    y: number,
    radius: number,
    rgba: [number, number, number, number],
  ) {
    const { minX, maxX, minY, maxY, halfWidth, halfHeight } = getStampBounds(x, y, radius);

    if (
      x + halfWidth < 0 ||
      y + halfHeight < 0 ||
      x - halfWidth >= CANVAS_WIDTH ||
      y - halfHeight >= CANVAS_HEIGHT ||
      maxX < minX ||
      maxY < minY
    ) {
      return false;
    }

    pendingStamps.push({ x, y, radius, rgba });
    if (isDrawing) strokeHadPaint = true;
    scheduleFrame();
    return true;
  }

  function stampLine(
    x1: number,
    y1: number,
    r1: number,
    o1: number,
    x2: number,
    y2: number,
    r2: number,
    o2: number,
    rgba: [number, number, number, number],
  ) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;

    let travelled = 0;
    while (travelled < dist) {
      const spacingT = travelled / dist;
      const spacingRadius = lerp(r1, r2, spacingT);
      const spacing = getStampSpacing(spacingRadius);
      const distanceToNextStamp = Math.max(0, spacing - distanceSinceLastStamp);
      const remainingDistance = dist - travelled;

      if (distanceToNextStamp > remainingDistance) {
        distanceSinceLastStamp += remainingDistance;
        return;
      }

      travelled += distanceToNextStamp;
      const t = travelled / dist;
      const radius = lerp(r1, r2, t);
      const opacity = lerp(o1, o2, t);
      queueStamp(
        x1 + dx * t,
        y1 + dy * t,
        radius,
        withAlpha(rgba, opacity),
      );
      distanceSinceLastStamp = 0;
    }
  }

  // ====================================================================
  //  WebGPU initialisation
  // ====================================================================

  $effect(() => {
    const canvas = canvasEl;
    if (!canvas) return;

    let cancelled = false;

    async function init() {
      if (!navigator.gpu) {
        error = "WebGPU is not available in this browser.";
        return;
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        error = "Could not get a WebGPU adapter.";
        return;
      }

      const dev = await adapter.requestDevice();
      if (cancelled) {
        dev.destroy();
        return;
      }

      const ctx = canvas!.getContext("webgpu");
      if (!ctx) {
        error = "Could not get a WebGPU canvas context.";
        return;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device: dev, format, alphaMode: "premultiplied" });

      const compositeTex = createDocumentTexture(dev, "Composite texture");
      const compositeView = compositeTex.createView();

      const brushBitmap = await loadBrushStampBitmap();
      if (cancelled) {
        brushBitmap.close?.();
        compositeTex.destroy();
        dev.destroy();
        return;
      }

      const brushTex = dev.createTexture({
        size: [brushBitmap.width, brushBitmap.height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      dev.queue.copyExternalImageToTexture(
        { source: brushBitmap },
        { texture: brushTex },
        [brushBitmap.width, brushBitmap.height],
      );
      brushBitmap.close?.();

      const paintSampler = dev.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
      });
      const brushSampler = dev.createSampler({
        magFilter: "linear",
        minFilter: "linear",
      });
      const layerSampler = dev.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
      });

      // Storage buffer for stamp data (12 f32 × MAX_STAMPS_PER_FRAME)
      const brushBufSize = FLOATS_PER_STAMP * MAX_STAMPS_PER_FRAME * 4; // f32 = 4 bytes
      const brushBuf = dev.createBuffer({
        size: brushBufSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Pre-allocate CPU-side view for filling stamp data
      stampDataView = new Float32Array(FLOATS_PER_STAMP * MAX_STAMPS_PER_FRAME);

      // Stamp uniforms (16 bytes; vec2f + padding)
      const stampUbo = dev.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      dev.queue.writeBuffer(stampUbo, 0, new Float32Array([CANVAS_WIDTH, CANVAS_HEIGHT, 0, 0]));

      // View uniforms (32 bytes)
      const viewUbo = dev.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // ---- Render pipeline (stamp into active layer texture) ----
      const stampBindGroupLayout = dev.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
          { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
          { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        ],
      });

      const stampShaderModule = dev.createShaderModule({ code: stampShaderCode });
      const stmpPipeline = dev.createRenderPipeline({
        layout: dev.createPipelineLayout({
          bindGroupLayouts: [stampBindGroupLayout],
        }),
        vertex: {
          module: stampShaderModule,
          entryPoint: "vs",
        },
        fragment: {
          module: stampShaderModule,
          entryPoint: "fs",
          targets: [
            {
              format: "rgba8unorm",
              blend: {
                color: {
                  operation: "add",
                  srcFactor: "src-alpha",
                  dstFactor: "one-minus-src-alpha",
                },
                alpha: {
                  operation: "add",
                  srcFactor: "one",
                  dstFactor: "one-minus-src-alpha",
                },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      });

      const stmpBindGroup = dev.createBindGroup({
        layout: stampBindGroupLayout,
        entries: [
          { binding: 0, resource: brushSampler },
          { binding: 1, resource: brushTex.createView() },
          { binding: 2, resource: { buffer: brushBuf } },
          { binding: 3, resource: { buffer: stampUbo } },
        ],
      });

      // ---- Composite pipeline (visible layers into composite texture) ----
      const compBindGroupLayout = dev.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        ],
      });

      const compPipeline = dev.createRenderPipeline({
        layout: dev.createPipelineLayout({
          bindGroupLayouts: [compBindGroupLayout],
        }),
        vertex: {
          module: dev.createShaderModule({ code: compositeShaderCode }),
          entryPoint: "vs",
        },
        fragment: {
          module: dev.createShaderModule({ code: compositeShaderCode }),
          entryPoint: "fs",
          targets: [
            {
              format: "rgba8unorm",
              blend: {
                color: {
                  operation: "add",
                  srcFactor: "one",
                  dstFactor: "one-minus-src-alpha",
                },
                alpha: {
                  operation: "add",
                  srcFactor: "one",
                  dstFactor: "one-minus-src-alpha",
                },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      });

      compositeBindGroupLayout = compBindGroupLayout;
      compositeSampler = layerSampler;

      // ---- Render pipeline (blit) ----
      const renderBindGroupLayout = dev.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ],
      });

      const rndrPipeline = dev.createRenderPipeline({
        layout: dev.createPipelineLayout({
          bindGroupLayouts: [renderBindGroupLayout],
        }),
        vertex: {
          module: dev.createShaderModule({ code: blitShaderCode }),
          entryPoint: "vs",
        },
        fragment: {
          module: dev.createShaderModule({ code: blitShaderCode }),
          entryPoint: "fs",
          targets: [{ format }],
        },
        primitive: { topology: "triangle-list" },
      });

      const rndrBindGroup = dev.createBindGroup({
        layout: renderBindGroupLayout,
        entries: [
          { binding: 0, resource: paintSampler },
          { binding: 1, resource: compositeView },
          { binding: 2, resource: { buffer: viewUbo } },
        ],
      });

      const initialLayer = createPaintLayer(dev, { name: "Layer 1" });
      nextLayerNumber = 2;
      layers = [initialLayer];
      activeLayerId = initialLayer.id;
      syncLayerList();
      markCompositeDirty();

      // Store refs
      device = dev;
      context = ctx;
      compositeTexture = compositeTex;
      compositeTextureView = compositeView;
      brushStampTexture = brushTex;
      stampBuffer = brushBuf;
      stampUniformBuffer = stampUbo;
      viewUniformBuffer = viewUbo;
      stampPipeline = stmpPipeline;
      compositePipeline = compPipeline;
      renderPipeline = rndrPipeline;
      stampBindGroup = stmpBindGroup;
      renderBindGroup = rndrBindGroup;

      // Initial present
      if (canvasWidth > 0 && canvasHeight > 0) {
        scheduleFrame();
      }
    }

    init().catch((e) => {
      console.error(e);
      error = "Failed to initialize WebGPU.";
    });

    return () => {
      cancelled = true;
      compositeTexture?.destroy();
      brushStampTexture?.destroy();
      stampBuffer?.destroy();
      stampUniformBuffer?.destroy();
      viewUniformBuffer?.destroy();
      for (const layer of layers) {
        destroyLayer(layer);
      }
      for (const entry of historyEntries) {
        destroyHistoryEntry(entry);
      }
      currentStrokeHistory?.before.destroy();
      currentStrokeHistory = null;
      device = null;
      context = null;
      compositeTexture = null;
      compositeTextureView = null;
      brushStampTexture = null;
      stampBuffer = null;
      stampUniformBuffer = null;
      viewUniformBuffer = null;
      stampPipeline = null;
      compositePipeline = null;
      renderPipeline = null;
      stampBindGroup = null;
      renderBindGroup = null;
      layers = [];
      layerList = [];
      activeLayerId = null;
      historyEntries = [];
      historyIndex = -1;
    };
  });

  // ====================================================================
  //  Canvas resize via ResizeObserver
  // ====================================================================

  $effect(() => {
    const canvas = canvasEl;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width * dpr);
        const h = Math.round(entry.contentRect.height * dpr);
        if (w === 0 || h === 0) continue;

        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          canvasWidth = w;
          canvasHeight = h;

          if (!hasFitInitialView) {
            hasFitInitialView = true;
            fitToScreen();
          } else if (device && context && renderPipeline && renderBindGroup) {
            scheduleFrame();
          }
        }
      }
    });

    observer.observe(canvas);

    return () => observer.disconnect();
  });

  // ====================================================================
  //  Zoom helpers
  // ====================================================================

  function applyZoom(factor: number, cursorX: number, cursorY: number) {
    const oldZoom = zoom;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
    if (newZoom === oldZoom) return;

    const newOffsetX = offsetX + cursorX * (1 / oldZoom - 1 / newZoom);
    const newOffsetY = offsetY + cursorY * (1 / oldZoom - 1 / newZoom);

    zoom = newZoom;
    offsetX = newOffsetX;
    offsetY = newOffsetY;

    scheduleFrame();
  }

  function fitToScreen() {
    const canvas = canvasEl;
    if (!canvas) return;
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(vw / CANVAS_WIDTH, vh / CANVAS_HEIGHT)));
    const visibleWidth = vw / scale;
    const visibleHeight = vh / scale;
    zoom = scale;
    offsetX = (CANVAS_WIDTH - visibleWidth) / 2;
    offsetY = (CANVAS_HEIGHT - visibleHeight) / 2;
    scheduleFrame();
  }

  function zoomTo100() {
    zoom = 1;
    offsetX = 0;
    offsetY = 0;
    scheduleFrame();
  }

  // ====================================================================
  //  Event handlers
  // ====================================================================

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    wheelAccum += e.deltaY;
    const threshold = 30;
    if (Math.abs(wheelAccum) < threshold) return;

    const rect = canvasEl!.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    const factor = wheelAccum < 0 ? 1.1 : 0.9;
    wheelAccum = 0;
    applyZoom(factor, cursorX, cursorY);
  }

  function handlePointerDown(e: PointerEvent) {
    const canvas = canvasEl;
    if (!canvas) return;

    updateBrushPreview(e);

    if (e.button === 1 || (e.button === 0 && isSpaceHeld)) {
      brushPreviewVisible = false;
      isPanning = true;
      panStart = {
        clientX: e.clientX,
        clientY: e.clientY,
        offsetX,
        offsetY,
      };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button === 0 && e.shiftKey) {
      brushPreviewVisible = false;
      isResizingBrush = true;
      resizeStartY = e.clientY;
      resizeStartBrushSize = brushSize;
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button === 0) {
      const activeLayer = getActiveLayer();
      if (!device || !activeLayer || !activeLayer.visible || activeLayer.locked) return;

      isDrawing = true;
      strokeUsesPressure = hasRealPressure(e);
      currentStrokeHistory?.before.destroy();
      currentStrokeHistory = {
        layerId: activeLayer.id,
        before: copyTexture(device, activeLayer.texture, "Paint stroke before snapshot"),
      };
      strokeHadPaint = false;

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const { x, y } = screenToCanvas(screenX, screenY);
      const radius = getRadius(e, brushSize * MIN_PRESSURE_SIZE / 2);
      const opacity = getOpacity(e, MIN_PRESSURE_OPACITY);
      const rgba = hexToVec4(color);
      lastPoint = { x, y, radius, opacity };
      distanceSinceLastStamp = 0;
      queueStamp(x, y, radius, withAlpha(rgba, opacity));
      canvas.setPointerCapture(e.pointerId);
    }
  }

  function handlePointerMove(e: PointerEvent) {
    updateBrushPreview(e);

    if (isResizingBrush) {
      const deltaY = e.clientY - resizeStartY;
      brushSize = Math.round(
        clamp(resizeStartBrushSize - deltaY, 1, 500),
      );
      updateBrushPreview(e);
      return;
    }

    if (isPanning) {
      const dx = e.clientX - panStart.clientX;
      const dy = e.clientY - panStart.clientY;
      offsetX = panStart.offsetX - dx / zoom;
      offsetY = panStart.offsetY - dy / zoom;
      scheduleFrame();
      brushPreviewVisible = false;
      return;
    }

    if (!isDrawing) return;

    if (!strokeUsesPressure && hasRealPressure(e)) {
      strokeUsesPressure = true;
    }

    const canvas = canvasEl;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const { x, y } = screenToCanvas(screenX, screenY);

    const radius = getRadius(e, lastPoint.radius || brushSize * MIN_PRESSURE_SIZE / 2);
    const opacity = getOpacity(e, lastPoint.opacity);
    stampLine(
      lastPoint.x,
      lastPoint.y,
      lastPoint.radius,
      lastPoint.opacity,
      x,
      y,
      radius,
      opacity,
      hexToVec4(color),
    );
    lastPoint = { x, y, radius, opacity };
  }

  function handlePointerUp(e: PointerEvent) {
    const wasDrawing = isDrawing;

    isDrawing = false;
    isPanning = false;
    isResizingBrush = false;
    strokeUsesPressure = false;
    distanceSinceLastStamp = 0;
    updateBrushPreview(e);

    if (wasDrawing) {
      shouldSaveHistoryAfterFrame = true;
      scheduleFrame();
    }

    try {
      canvasEl?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function handlePointerLeave() {
    const wasDrawing = isDrawing;
    isDrawing = false;
    strokeUsesPressure = false;
    distanceSinceLastStamp = 0;
    brushPreviewVisible = false;

    if (wasDrawing) {
      shouldSaveHistoryAfterFrame = true;
      scheduleFrame();
    }
  }

  function updateBrushPreview(e: PointerEvent) {
    const canvas = canvasEl;
    if (!canvas || isPanning || isSpaceHeld) {
      brushPreviewVisible = false;
      return;
    }

    const rect = canvas.getBoundingClientRect();
    brushPreviewX = e.clientX - rect.left;
    brushPreviewY = e.clientY - rect.top;
    brushPreviewRadius = getPreviewRadius(e);
    brushPreviewVisible = true;
  }

  function getPreviewRadius(e: PointerEvent): number {
    // Hover always previews the lowest pressure size.
    if (!isDrawing) {
      return brushSize * MIN_PRESSURE_SIZE / 2;
    }

    if (strokeUsesPressure) {
      return getRadius(e, brushPreviewRadius || brushSize * MIN_PRESSURE_SIZE / 2);
    }

    return brushSize / 2;
  }

  function hasRealPressure(e: PointerEvent): boolean {
    const p = typeof e.pressure === "number" ? e.pressure : 0;
    return e.pointerType === "pen" || (p > 0 && Math.abs(p - PRESSURE_FALLBACK) > PRESSURE_EPSILON);
  }

  function getRadius(e: PointerEvent, fallbackRadius: number): number {
    if (!strokeUsesPressure) {
      return brushSize / 2;
    }

    const p = typeof e.pressure === "number" ? e.pressure : 0;
    if (p > 0) {
      const pressureScale = MIN_PRESSURE_SIZE + (1 - MIN_PRESSURE_SIZE) * clamp(p, 0, 1);
      return brushSize * pressureScale / 2;
    }

    return fallbackRadius;
  }

  function getOpacity(e: PointerEvent, fallbackOpacity: number): number {
    if (!strokeUsesPressure) return 1;

    const p = typeof e.pressure === "number" ? e.pressure : 0;
    if (p > 0) {
      const pressure = clamp(p, 0, 1);
      return MIN_PRESSURE_OPACITY +
        (1 - MIN_PRESSURE_OPACITY) * Math.pow(pressure, PRESSURE_OPACITY_GAMMA);
    }

    return fallbackOpacity;
  }

  // ====================================================================
  //  Keyboard shortcuts
  // ====================================================================

  $effect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        isSpaceHeld = true;
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        addLayer();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        const cw = canvasEl?.clientWidth ?? CANVAS_WIDTH;
        const ch = canvasEl?.clientHeight ?? CANVAS_HEIGHT;
        applyZoom(1.25, cw / 2, ch / 2);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        const cw = canvasEl?.clientWidth ?? CANVAS_WIDTH;
        const ch = canvasEl?.clientHeight ?? CANVAS_HEIGHT;
        applyZoom(0.8, cw / 2, ch / 2);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        fitToScreen();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "1") {
        e.preventDefault();
        zoomTo100();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))
      ) {
        e.preventDefault();
        redo();
        return;
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        e.preventDefault();
        isSpaceHeld = false;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  });
</script>

<div class="relative inline-block select-none">
  {#if error}
    <div class="absolute inset-0 z-20 flex items-center justify-center rounded-md bg-zinc-900/90 p-4 text-center text-sm text-white">
      {error}
    </div>
  {/if}

  <canvas
    bind:this={canvasEl}
    class="block h-screen w-screen bg-neutral-500"
    style="image-rendering: {imageRenderHint}; cursor: {cursor}"
    onwheel={handleWheel}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointerleave={handlePointerLeave}
    oncontextmenu={(e: MouseEvent) => e.preventDefault()}
  ></canvas>

  {#if brushPreviewVisible}
    <div
      class="pointer-events-none absolute"
      style="left: {brushPreviewX}px; top: {brushPreviewY}px; width: {brushPreviewWidth}px; height: {brushPreviewHeight}px; transform: translate(-50%, -50%);"
    >
      <div
        class="absolute inset-0"
        style="background: rgba(255, 255, 255, 0.01); -webkit-backdrop-filter: invert(1); backdrop-filter: invert(1); -webkit-mask: url('{brushStampOutlineUrl}') center / contain no-repeat; mask: url('{brushStampOutlineUrl}') center / contain no-repeat; filter: drop-shadow(0 0 1px rgba(255, 255, 255, 0.9)) drop-shadow(0 0 2px rgba(0, 0, 0, 0.7));"
      ></div>
    </div>
  {/if}

  <LayerPanel
    layers={layerList}
    ondelete={deleteLayer}
    onselect={setActiveLayer}
    onvisiblechange={setLayerVisible}
    onnamechange={setLayerName}
    onlockedchange={setLayerLocked}
  />

  <div class="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
    {Math.round(zoom * 100)}% · {brushSize}px
  </div>
</div>
