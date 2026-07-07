<script lang="ts">
  /// <reference types="@webgpu/types" />

  import LayerPanel from "./LayerPanel.svelte";
  import {
    COPY_BYTES_PER_ROW_ALIGNMENT,
    DEFAULT_CANVAS_HEIGHT,
    DEFAULT_CANVAS_WIDTH,
    FLOATS_PER_STAMP,
    MAX_CANVAS_SIZE,
    MAX_STAMPS_PER_FRAME,
    MAX_ZOOM,
    MIN_CANVAS_SIZE,
    MIN_ZOOM,
  } from "./core/constants";
  import { hexToVec4, withAlpha, type Rgba } from "./core/color";
  import { getStampBounds, getStampHalfSize, getStampSpacing } from "./core/geometry";
  import { clamp, lerp } from "./core/math";
  import type { LayerId, LayerMetadata } from "./core/types";
  import { HistoryManager, type HistoryEntry, type LayerAddHistoryEntry } from "./document/history";
  import {
    applyLayerMetadata,
    captureLayerMetadata,
    createLayerList,
    getNextLayerNumber,
    makeLayerId,
    type LayerListItem,
    type PaintLayer,
  } from "./document/layers";
  import {
    createEyedropperReadBuffer,
    createStampBuffer,
    createStampUniformBuffer,
    createViewUniformBuffer,
  } from "./gpu/buffers";
  import { createBrushStampTexture, loadBrushStampBitmap } from "./gpu/brushStamp";
  import {
    createCompositePipelineResources,
    createStampPipelineResources,
    createViewportPipelineResources,
  } from "./gpu/pipelines";
  import {
    blitCompositeToViewport as renderCompositeToViewport,
    rebuildComposite as renderRebuildComposite,
    renderStamps,
    writeViewUniforms as writeGpuViewUniforms,
  } from "./gpu/rendering";
  import {
    clearTexture,
    copyTexture,
    createDocumentTexture,
    readTexturePixels,
    restoreTexture,
    uploadTexturePixels,
  } from "./gpu/textures";
  import {
    getBrushOpacity,
    getBrushPreviewRadius,
    getBrushRadius,
    getMinimumPressureOpacity,
    getMinimumPressureRadius,
    hasRealPressure,
    resizeBrushSize,
  } from "./input/brush";
  import {
    applyZoomAt,
    fitDocumentToViewport,
    panView,
    screenToCanvas as screenToCanvasPoint,
    zoomToActualSize,
  } from "./input/panZoom";
  import { createProjectBlob, decodeProjectBlob } from "./persistence/projectIO";
  import { pixelsToPngBlob } from "./persistence/png";
  import brushStampUrl from "../assets/charcoal-removebg-preview.png";
  import brushStampOutlineUrl from "../assets/charcoal-removebg-preview.png";

  interface Props {
    color: string;
    brushSize: number;
  }

  let { color = $bindable(), brushSize = $bindable() }: Props = $props();

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
  let isEyedropperHeld = $state(false);
  let isEyedropping = $state(false);

  // ---- image rendering hint ----
  let imageRenderHint = $derived(zoom < 1 ? "auto" : "pixelated");

  // ---- cursor ----
  let cursor = $derived(
    isEyedropperHeld || isEyedropping
      ? "crosshair"
      : isPanning
        ? "grabbing"
        : isSpaceHeld
          ? "grab"
          : "none"
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
  let renderBindGroupLayout: GPUBindGroupLayout | null = null;
  let paintSampler: GPUSampler | null = null;

  // ---- layer state ----
  let documentWidth = $state(DEFAULT_CANVAS_WIDTH);
  let documentHeight = $state(DEFAULT_CANVAS_HEIGHT);
  let layers: PaintLayer[] = [];
  let layerList = $state<LayerListItem[]>([]);
  let activeLayerId = $state<LayerId | null>(null);
  let compositeDirty = true;
  let nextLayerNumber = 1;

  // ---- undo / redo state ----
  let history = new HistoryManager();
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

  // ---- eyedropper state ----
  let isEyedropperReading = false;
  let eyedropperNeedsResample = false;
  let eyedropperLastScreenX = 0;
  let eyedropperLastScreenY = 0;
  let eyedropperRafId: number | null = null;
  let eyedropperReadBuffer: GPUBuffer | null = null;

  // ---- pan tracking ----
  let panStart = { clientX: 0, clientY: 0, offsetX: 0, offsetY: 0 };

  // ---- wheel accumulator ----
  let wheelAccum = 0;

  // ---- pending stamps (batched per frame) ----
  type PendingStamp = {
    x: number;
    y: number;
    radius: number;
    rgba: Rgba;
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

  async function readTextureAsPngBlob(dev: GPUDevice, texture: GPUTexture) {
    return await pixelsToPngBlob(
      await readTexturePixels(dev, texture, documentWidth, documentHeight),
      documentWidth,
      documentHeight,
    );
  }

  function screenToCanvas(screenX: number, screenY: number) {
    return screenToCanvasPoint(screenX, screenY, { zoom, offsetX, offsetY });
  }

  // ====================================================================
  //  WebGPU helpers
  // ====================================================================

  function recreateCompositeResources(dev: GPUDevice) {
    if (!renderBindGroupLayout || !paintSampler || !viewUniformBuffer) {
      throw new Error("Viewport rendering is not ready.");
    }

    const oldCompositeTexture = compositeTexture;
    const texture = createDocumentTexture(dev, documentWidth, documentHeight, "Composite texture");
    const view = texture.createView();
    const bindGroup = dev.createBindGroup({
      layout: renderBindGroupLayout,
      entries: [
        { binding: 0, resource: paintSampler },
        { binding: 1, resource: view },
        { binding: 2, resource: { buffer: viewUniformBuffer } },
      ],
    });

    compositeTexture = texture;
    compositeTextureView = view;
    renderBindGroup = bindGroup;
    oldCompositeTexture?.destroy();
    markCompositeDirty();
  }

  function getActiveLayer() {
    return layers.find((layer) => layer.id === activeLayerId) ?? null;
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
    const texture = createDocumentTexture(dev, documentWidth, documentHeight, `Paint layer ${layerId}`);
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
      restoreTexture(dev, texture, sourcePixels, documentWidth, documentHeight);
    } else {
      clearTexture(dev, texture, [0, 0, 0, 0]);
    }

    return layer;
  }

  function destroyLayer(layer: PaintLayer) {
    layer.texture.destroy();
  }

  function syncLayerList() {
    layerList = createLayerList(layers, activeLayerId);
  }

  function markCompositeDirty() {
    compositeDirty = true;
  }

  function clearHistory() {
    history.clear();
    currentStrokeHistory?.before.destroy();
    currentStrokeHistory = null;
    shouldSaveHistoryAfterFrame = false;
    strokeHadPaint = false;
  }

  function replaceLayers(nextLayers: PaintLayer[], nextActiveLayerId: LayerId | null) {
    for (const layer of layers) {
      destroyLayer(layer);
    }

    layers = nextLayers;
    activeLayerId = nextActiveLayerId && layers.some((layer) => layer.id === nextActiveLayerId)
      ? nextActiveLayerId
      : layers[layers.length - 1]?.id ?? null;
    syncLayerList();
    markCompositeDirty();
  }

  function updateNextLayerNumber() {
    nextLayerNumber = getNextLayerNumber(layers);
  }

  function finalizePendingPaintHistory() {
    if (!shouldSaveHistoryAfterFrame) return;

    if (currentStrokeHistory && strokeHadPaint) {
      history.push({
        kind: "paint"},{
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

  function reorderLayerStack(order: LayerId[]) {
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    layers = order
      .map((id) => byId.get(id))
      .filter((layer): layer is PaintLayer => Boolean(layer));
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
      entry.redo = copyTexture(device, layer.texture, documentWidth, documentHeight, "Paint redo snapshot");
      restoreTexture(device, layer.texture, entry.before, documentWidth, documentHeight);
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
    } else if (entry.kind === "layer-reorder") {
      reorderLayerStack(entry.beforeOrder);
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
      restoreTexture(device, layer.texture, entry.redo, documentWidth, documentHeight);
      activeLayerId = entry.layerId;
    } else if (entry.kind === "layer-metadata") {
      const layer = layers.find((item) => item.id === entry.layerId);
      if (layer) applyLayerMetadata(layer, entry.after);
    } else if (entry.kind === "layer-add") {
      restoreLayerAdd(entry);
    } else if (entry.kind === "layer-delete") {
      removeLayerById(entry.layerId);
      activeLayerId = entry.activeAfter;
    } else if (entry.kind === "layer-reorder") {
      reorderLayerStack(entry.afterOrder);
      activeLayerId = entry.activeAfter;
    }

    syncLayerList();
    markCompositeDirty();
  }

  export function undo() {
    if (!device || !history.canUndo) return;

    flushPendingWorkForExport();
    resetInteractionState();

    const entry = history.takeUndoEntry();
    if (entry) applyUndo(entry);
    scheduleFrame();
  }

  export function redo() {
    if (!device || !history.canRedo) return;

    flushPendingWorkForExport();
    resetInteractionState();

    const entry = history.takeRedoEntry();
    if (entry) applyRedo(entry);
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
    history.push({
      kind: "layer-add"},{
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
    const pixels = copyTexture(device, layer.texture, documentWidth, documentHeight, "Deleted layer snapshot");
    const metadata = captureLayerMetadata(layer);
    const activeAfter = activeBefore === metadata.id
      ? layers[Math.min(index, layers.length - 1)]?.id ?? null
      : activeBefore;
    destroyLayer(layer);
    activeLayerId = activeAfter;
    syncLayerList();
    markCompositeDirty();
    history.push({
      kind: "layer-delete"},{
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

  export function setLayerOrder(topToBottomIds: LayerId[]) {
    if (topToBottomIds.length !== layers.length) return;

    const currentIds = new Set(layers.map((layer) => layer.id));
    if (!topToBottomIds.every((id) => currentIds.has(id))) return;

    const beforeOrder = layers.map((layer) => layer.id);
    const afterOrder = topToBottomIds.slice().reverse();
    if (beforeOrder.join("\0") === afterOrder.join("\0")) return;

    reorderLayerStack(afterOrder);
    syncLayerList();
    markCompositeDirty();
    history.push({
      kind: "layer-reorder"},{
      beforeOrder,
      afterOrder,
      activeBefore: activeLayerId,
      activeAfter: activeLayerId,
    });
    scheduleFrame();
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
    history.push({ kind: "layer-metadata", layerId: id, before, after });
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

  export function newProject(width = DEFAULT_CANVAS_WIDTH, height = DEFAULT_CANVAS_HEIGHT) {
    if (!device) throw new Error("Canvas is not ready to create a new project yet.");

    const nextWidth = Math.round(clamp(width, MIN_CANVAS_SIZE, MAX_CANVAS_SIZE));
    const nextHeight = Math.round(clamp(height, MIN_CANVAS_SIZE, MAX_CANVAS_SIZE));

    cancelScheduledFrame();
    resetInteractionState();
    pendingStamps = [];
    clearHistory();

    documentWidth = nextWidth;
    documentHeight = nextHeight;
    device.queue.writeBuffer(stampUniformBuffer!, 0, new Float32Array([documentWidth, documentHeight, 0, 0]));
    recreateCompositeResources(device);

    const initialLayer = createPaintLayer(device, { name: "Layer 1" });
    replaceLayers([initialLayer], initialLayer.id);
    nextLayerNumber = 2;
    fitToScreen();
    scheduleFrame();
  }

  export async function saveProject() {
    if (!device) throw new Error("Canvas is not ready to save yet.");

    flushPendingWorkForExport();

    return await createProjectBlob({
      width: documentWidth,
      height: documentHeight,
      activeLayerId,
      view: {
        zoom,
        offsetX,
        offsetY,
      },
      brush: {
        color,
        size: brushSize,
      },
      layers: await Promise.all(
        layers.map(async (layer) => ({
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
          locked: layer.locked,
          pixels: await readTexturePixels(device, layer.texture, documentWidth, documentHeight),
        })),
      ),
    });
  }

  export async function loadProject(blob: Blob) {
    if (!device) throw new Error("Canvas is not ready to open a project yet.");

    cancelScheduledFrame();
    resetInteractionState();
    pendingStamps = [];

    const { manifest, layers: decodedLayers } = await decodeProjectBlob(blob);
    const loadedLayers: PaintLayer[] = [];
    resetInteractionState();
    pendingStamps = [];
    clearHistory();
    documentWidth = manifest.canvas.width;
    documentHeight = manifest.canvas.height;
    device.queue.writeBuffer(stampUniformBuffer!, 0, new Float32Array([documentWidth, documentHeight, 0, 0]));
    recreateCompositeResources(device);

    try {
      for (const decodedLayer of decodedLayers) {
        const layer = createPaintLayer(device, decodedLayer.metadata);
        uploadTexturePixels(device, layer.texture, decodedLayer.pixels, documentWidth, documentHeight);
        loadedLayers.push(layer);
      }
    } catch (e) {
      for (const layer of loadedLayers) {
        destroyLayer(layer);
      }
      throw e;
    }

    replaceLayers(loadedLayers, manifest.activeLayerId);
    updateNextLayerNumber();
    zoom = clamp(manifest.view.zoom, MIN_ZOOM, MAX_ZOOM);
    offsetX = manifest.view.offsetX;
    offsetY = manifest.view.offsetY;
    color = manifest.brush.color;
    brushSize = clamp(Math.round(manifest.brush.size), 1, 500);
    hasFitInitialView = true;
    scheduleFrame();
    return { width: documentWidth, height: documentHeight };
  }

  function rebuildComposite(encoder: GPUCommandEncoder) {
    if (!compositeTextureView || !compositePipeline) return;
    renderRebuildComposite(encoder, compositeTextureView, compositePipeline, layers);
    compositeDirty = false;
  }

  function blitCompositeToViewport(encoder: GPUCommandEncoder) {
    if (!context || !renderPipeline || !renderBindGroup) return;
    writeViewUniforms(device!);
    renderCompositeToViewport(encoder, context, renderPipeline, renderBindGroup);
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

      const rendered = renderStamps({
        encoder,
        device,
        stampBuffer,
        stampDataView,
        stamps,
        count,
        documentWidth,
        documentHeight,
        activeLayer,
        stampPipeline,
        stampBindGroup,
      });
      if (rendered) markCompositeDirty();
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
    writeGpuViewUniforms(dev, viewUniformBuffer!, {
      cssWidth: canvasEl?.clientWidth ?? canvasWidth,
      cssHeight: canvasEl?.clientHeight ?? canvasHeight,
      canvasWidth,
      canvasHeight,
      zoom,
      offsetX,
      offsetY,
      documentWidth,
      documentHeight,
    });
  }

  function scheduleFrame() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(flushFrame);
  }

  function queueStamp(
    x: number,
    y: number,
    radius: number,
    rgba: Rgba,
  ) {
    const { minX, maxX, minY, maxY, halfWidth, halfHeight } = getStampBounds(
      x,
      y,
      radius,
      documentWidth,
      documentHeight,
    );

    if (
      x + halfWidth < 0 ||
      y + halfHeight < 0 ||
      x - halfWidth >= documentWidth ||
      y - halfHeight >= documentHeight ||
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
    rgba: Rgba,
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

      const compositeTex = createDocumentTexture(dev, documentWidth, documentHeight, "Composite texture");
      const compositeView = compositeTex.createView();

      const brushBitmap = await loadBrushStampBitmap(brushStampUrl);
      if (cancelled) {
        brushBitmap.close?.();
        compositeTex.destroy();
        dev.destroy();
        return;
      }

      const brushTex = createBrushStampTexture(dev, brushBitmap);
      brushBitmap.close?.();

      const paintSamp = dev.createSampler({
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

      const brushBuf = createStampBuffer(dev);

      // Pre-allocate CPU-side view for filling stamp data
      stampDataView = new Float32Array(FLOATS_PER_STAMP * MAX_STAMPS_PER_FRAME);

      const stampUbo = createStampUniformBuffer(dev, documentWidth, documentHeight);
      const viewUbo = createViewUniformBuffer(dev);
      const eyedropperBuf = createEyedropperReadBuffer(dev);

      const stampResources = createStampPipelineResources(
        dev,
        brushSampler,
        brushTex.createView(),
        brushBuf,
        stampUbo,
      );
      const compositeResources = createCompositePipelineResources(dev);
      const viewportResources = createViewportPipelineResources(
        dev,
        format,
        paintSamp,
        compositeView,
        viewUbo,
      );

      compositeBindGroupLayout = compositeResources.bindGroupLayout;
      compositeSampler = layerSampler;

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
      eyedropperReadBuffer = eyedropperBuf;
      stampPipeline = stampResources.pipeline;
      compositePipeline = compositeResources.pipeline;
      renderPipeline = viewportResources.pipeline;
      stampBindGroup = stampResources.bindGroup;
      renderBindGroup = viewportResources.bindGroup;
      renderBindGroupLayout = viewportResources.bindGroupLayout;
      paintSampler = paintSamp;

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
      if (eyedropperRafId !== null) {
        cancelAnimationFrame(eyedropperRafId);
        eyedropperRafId = null;
      }
      compositeTexture?.destroy();
      brushStampTexture?.destroy();
      stampBuffer?.destroy();
      stampUniformBuffer?.destroy();
      viewUniformBuffer?.destroy();
      eyedropperReadBuffer?.destroy();
      for (const layer of layers) {
        destroyLayer(layer);
      }
      history.clear();
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
      eyedropperReadBuffer = null;
      stampPipeline = null;
      compositePipeline = null;
      renderPipeline = null;
      stampBindGroup = null;
      renderBindGroup = null;
      renderBindGroupLayout = null;
      paintSampler = null;
      layers = [];
      layerList = [];
      activeLayerId = null;
      history = new HistoryManager();
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
    const next = applyZoomAt({ zoom, offsetX, offsetY }, factor, cursorX, cursorY);
    if (next.zoom === zoom && next.offsetX === offsetX && next.offsetY === offsetY) return;

    zoom = next.zoom;
    offsetX = next.offsetX;
    offsetY = next.offsetY;
    scheduleFrame();
  }

  function fitToScreen() {
    const canvas = canvasEl;
    if (!canvas) return;
    const next = fitDocumentToViewport(canvas.clientWidth, canvas.clientHeight, documentWidth, documentHeight);
    zoom = next.zoom;
    offsetX = next.offsetX;
    offsetY = next.offsetY;
    scheduleFrame();
  }

  function zoomTo100() {
    const next = zoomToActualSize();
    zoom = next.zoom;
    offsetX = next.offsetX;
    offsetY = next.offsetY;
    scheduleFrame();
  }

  function cancelEyedropperSample() {
    if (eyedropperRafId === null) return;
    cancelAnimationFrame(eyedropperRafId);
    eyedropperRafId = null;
  }

  function requestEyedropperSample(screenX: number, screenY: number) {
    eyedropperLastScreenX = screenX;
    eyedropperLastScreenY = screenY;

    if (isEyedropperReading) {
      eyedropperNeedsResample = true;
      return;
    }

    if (eyedropperRafId !== null) return;
    eyedropperRafId = requestAnimationFrame(() => {
      eyedropperRafId = null;
      void doEyedropperSample(eyedropperLastScreenX, eyedropperLastScreenY);
    });
  }

  async function doEyedropperSample(screenX: number, screenY: number) {
    if (!device || !compositeTexture || !eyedropperReadBuffer || !canvasEl) return;

    isEyedropperReading = true;

    try {
      const rect = canvasEl.getBoundingClientRect();
      const cssX = screenX - rect.left;
      const cssY = screenY - rect.top;
      const { x, y } = screenToCanvas(cssX, cssY);
      const docX = Math.floor(clamp(x, 0, documentWidth - 1));
      const docY = Math.floor(clamp(y, 0, documentHeight - 1));

      flushPendingWorkForExport();

      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: compositeTexture, origin: { x: docX, y: docY } },
        {
          buffer: eyedropperReadBuffer,
          bytesPerRow: COPY_BYTES_PER_ROW_ALIGNMENT,
          rowsPerImage: 1,
        },
        [1, 1, 1],
      );
      device.queue.submit([encoder.finish()]);

      await eyedropperReadBuffer.mapAsync(GPUMapMode.READ);
      const mapped = eyedropperReadBuffer.getMappedRange();
      const pixels = new Uint8Array(mapped);
      const r = pixels[0];
      const g = pixels[1];
      const b = pixels[2];
      const a = pixels[3];
      eyedropperReadBuffer.unmap();

      const unpremultiply = (channel: number) =>
        a === 0 ? 255 : Math.min(255, Math.round(channel * 255 / a));
      color =
        "#" +
        [unpremultiply(r), unpremultiply(g), unpremultiply(b)]
          .map((channel) => channel.toString(16).padStart(2, "0"))
          .join("");
    } finally {
      isEyedropperReading = false;
      if (eyedropperNeedsResample) {
        eyedropperNeedsResample = false;
        void doEyedropperSample(eyedropperLastScreenX, eyedropperLastScreenY);
      }
    }
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

    if (e.button === 0 && isEyedropperHeld) {
      e.preventDefault();
      brushPreviewVisible = false;
      isEyedropping = true;
      requestEyedropperSample(e.clientX, e.clientY);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

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
        before: copyTexture(device, activeLayer.texture, documentWidth, documentHeight, "Paint stroke before snapshot"),
      };
      strokeHadPaint = false;

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const { x, y } = screenToCanvas(screenX, screenY);
      const radius = getBrushRadius(e, brushSize, strokeUsesPressure, getMinimumPressureRadius(brushSize));
      const opacity = getBrushOpacity(e, strokeUsesPressure, getMinimumPressureOpacity());
      const rgba = hexToVec4(color);
      lastPoint = { x, y, radius, opacity };
      distanceSinceLastStamp = 0;
      queueStamp(x, y, radius, withAlpha(rgba, opacity));
      canvas.setPointerCapture(e.pointerId);
    }
  }

  function handlePointerMove(e: PointerEvent) {
    updateBrushPreview(e);

    if (isEyedropping) {
      requestEyedropperSample(e.clientX, e.clientY);
      return;
    }

    if (isResizingBrush) {
      brushSize = resizeBrushSize(resizeStartBrushSize, resizeStartY, e.clientY);
      updateBrushPreview(e);
      return;
    }

    if (isPanning) {
      const next = panView(panStart, e.clientX, e.clientY, zoom);
      offsetX = next.offsetX;
      offsetY = next.offsetY;
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

    const radius = getBrushRadius(e, brushSize, strokeUsesPressure, lastPoint.radius || getMinimumPressureRadius(brushSize));
    const opacity = getBrushOpacity(e, strokeUsesPressure, lastPoint.opacity);
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
    const wasEyedropping = isEyedropping;

    isDrawing = false;
    isPanning = false;
    isResizingBrush = false;
    isEyedropping = false;
    strokeUsesPressure = false;
    distanceSinceLastStamp = 0;
    cancelEyedropperSample();
    updateBrushPreview(e);

    if (wasDrawing) {
      shouldSaveHistoryAfterFrame = true;
      scheduleFrame();
    }

    if (wasEyedropping) {
      try {
        canvasEl?.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
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
    isEyedropping = false;
    strokeUsesPressure = false;
    distanceSinceLastStamp = 0;
    cancelEyedropperSample();
    brushPreviewVisible = false;

    if (wasDrawing) {
      shouldSaveHistoryAfterFrame = true;
      scheduleFrame();
    }
  }

  function updateBrushPreview(e: PointerEvent) {
    const canvas = canvasEl;
    if (!canvas || isPanning || isSpaceHeld || isEyedropperHeld || isEyedropping) {
      brushPreviewVisible = false;
      return;
    }

    const rect = canvas.getBoundingClientRect();
    brushPreviewX = e.clientX - rect.left;
    brushPreviewY = e.clientY - rect.top;
    brushPreviewRadius = getBrushPreviewRadius({
      e,
      isDrawing,
      usesPressure: strokeUsesPressure,
      brushSize,
      fallbackRadius: brushPreviewRadius || getMinimumPressureRadius(brushSize),
    });
    brushPreviewVisible = true;
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

      if ((e.code === "AltLeft" || e.code === "AltRight") && !e.repeat) {
        e.preventDefault();
        isEyedropperHeld = true;
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        addLayer();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        const cw = canvasEl?.clientWidth ?? documentWidth;
        const ch = canvasEl?.clientHeight ?? documentHeight;
        applyZoom(1.25, cw / 2, ch / 2);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        const cw = canvasEl?.clientWidth ?? documentWidth;
        const ch = canvasEl?.clientHeight ?? documentHeight;
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

      if (e.code === "AltLeft" || e.code === "AltRight") {
        e.preventDefault();
        isEyedropperHeld = false;
        isEyedropping = false;
        cancelEyedropperSample();
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
    onreorder={setLayerOrder}
    onvisiblechange={setLayerVisible}
    onnamechange={setLayerName}
    onlockedchange={setLayerLocked}
  />

  <div class="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
    {Math.round(zoom * 100)}% · {brushSize}px
  </div>
</div>
