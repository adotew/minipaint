<script lang="ts">
  /// <reference types="@webgpu/types" />

  import BrushPreview from "./BrushPreview.svelte";
  import CanvasStatus from "./CanvasStatus.svelte";
  import LayerPanel from "./LayerPanel.svelte";
  import {
    DEFAULT_CANVAS_HEIGHT,
    DEFAULT_CANVAS_WIDTH,
    MAX_BRUSH_SIZE,
    MAX_CANVAS_SIZE,
    MAX_ZOOM,
    MIN_CANVAS_SIZE,
    MIN_ZOOM,
  } from "./core/constants";
  import { hexToVec4, withAlpha, type Rgba } from "./core/color";
  import { getStampHalfSize } from "./core/geometry";
  import { clamp } from "./core/math";
  import type { LayerId, ToolMode } from "./core/types";
  import { type LayerListItem, type PaintLayer } from "./document/layers";
  import { PaintDocumentController } from "./document/paintDocument";
  import { StrokeHistoryManager } from "./document/strokeHistory";
  import { GpuPaintRenderer } from "./gpu/paintRenderer";
  import { initializeGpuCanvas } from "./gpu/rendererSetup";
  import {
    getBrushOpacity,
    getBrushPreviewRadius,
    getBrushRadius,
    getMinimumPressureOpacity,
    getMinimumPressureRadius,
    hasRealPressure,
    resizeBrushSize,
  } from "./input/brush";
  import { getKeyDownShortcutCommand, getKeyUpShortcutCommand } from "./input/keyboardShortcuts";
  import {
    applyZoomAt,
    fitDocumentToViewport,
    panView,
    screenToCanvas as screenToCanvasPoint,
    zoomToActualSize,
  } from "./input/panZoom";
  import { createProjectBlob, decodeProjectBlob } from "./persistence/projectIO";
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
  let toolMode = $state<ToolMode>("brush");
  let strokeToolMode: ToolMode = "brush";
  let brushPreviewVisible = $state(false);
  let brushPreviewX = $state(0);
  let brushPreviewY = $state(0);
  let brushPreviewRadius = $state(0);
  let brushPreviewWidth = $derived(Math.max(1, getStampHalfSize(brushPreviewRadius).halfWidth * 2 * zoom));
  let brushPreviewHeight = $derived(Math.max(1, getStampHalfSize(brushPreviewRadius).halfHeight * 2 * zoom));

  // ---- WebGPU renderer ----
  let renderer: GpuPaintRenderer | null = $state(null);

  // ---- layer state ----
  let documentWidth = $state(DEFAULT_CANVAS_WIDTH);
  let documentHeight = $state(DEFAULT_CANVAS_HEIGHT);
  let documentController: PaintDocumentController | null = null;
  let layers: PaintLayer[] = [];
  let layerList = $state<LayerListItem[]>([]);
  let activeLayerId = $state<LayerId | null>(null);

  // ---- undo / redo state ----
  let strokeHistory = new StrokeHistoryManager();

  // ---- drawing state ----
  let isDrawing = false;
  let strokeUsesPressure = false;
  let lastPoint = { x: 0, y: 0, radius: 0, opacity: 1 };

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

  // ---- pan tracking ----
  let panStart = { clientX: 0, clientY: 0, offsetX: 0, offsetY: 0 };

  // ---- wheel accumulator ----
  let wheelAccum = 0;


  // ---- current canvas internal size (set by ResizeObserver) ----
  let canvasWidth = $state(0);
  let canvasHeight = $state(0);

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

  function screenToCanvas(screenX: number, screenY: number) {
    return screenToCanvasPoint(screenX, screenY, { zoom, offsetX, offsetY });
  }

  // ====================================================================
  //  WebGPU helpers
  // ====================================================================

  function syncDocumentState() {
    layers = documentController?.layers ?? [];
    activeLayerId = documentController?.activeLayerId ?? null;
    layerList = documentController?.layerList ?? [];
  }

  function getActiveLayer() {
    return documentController?.activeLayer ?? null;
  }

  function destroyLayer(layer: PaintLayer) {
    documentController?.destroyLayer(layer);
  }

  function markCompositeDirty() {
    renderer?.markCompositeDirty();
  }

  function syncRendererViewState() {
    renderer?.setViewState({
      cssWidth: canvasEl?.clientWidth ?? canvasWidth,
      cssHeight: canvasEl?.clientHeight ?? canvasHeight,
      canvasWidth,
      canvasHeight,
      zoom,
      offsetX,
      offsetY,
    });
  }

  function scheduleFrame() {
    syncRendererViewState();
    renderer?.scheduleFrame();
  }

  function flushPendingWorkForExport() {
    syncRendererViewState();
    renderer?.flushPendingWork();
    if (strokeHistory.shouldSaveAfterFrame) finalizePendingPaintHistory();
  }

  function clearHistory() {
    documentController?.clearHistory();
    strokeHistory.clear();
  }

  function replaceLayers(nextLayers: PaintLayer[], nextActiveLayerId: LayerId | null) {
    documentController?.replaceLayers(nextLayers, nextActiveLayerId);
    syncDocumentState();
  }

  function finalizePendingPaintHistory() {
    if (!documentController) return;
    strokeHistory.finalize(documentController.history);
  }

  function resetInteractionState() {
    isDrawing = false;
    isPanning = false;
    isResizingBrush = false;
    isEyedropping = false;
    strokeUsesPressure = false;
    if (renderer) renderer.stampDistanceSinceLastStamp = 0;
  }

  export function undo() {
    if (!renderer || !documentController?.canUndo) return;

    flushPendingWorkForExport();
    resetInteractionState();

    documentController.undo();
    syncDocumentState();
    scheduleFrame();
  }

  export function redo() {
    if (!renderer || !documentController?.canRedo) return;

    flushPendingWorkForExport();
    resetInteractionState();

    documentController.redo();
    syncDocumentState();
    scheduleFrame();
  }

  export function addLayer() {
    if (!documentController) return;
    documentController.addLayer();
    syncDocumentState();
    scheduleFrame();
  }

  export function deleteLayer(layerId: LayerId) {
    if (!documentController) return;
    documentController.deleteLayer(layerId);
    syncDocumentState();
    scheduleFrame();
  }

  export function setActiveLayer(id: LayerId) {
    documentController?.setActiveLayer(id);
    syncDocumentState();
  }

  export function setLayerOrder(topToBottomIds: LayerId[]) {
    documentController?.setLayerOrder(topToBottomIds);
    syncDocumentState();
    scheduleFrame();
  }

  function updateLayerMetadata(id: LayerId, update: (layer: PaintLayer) => void) {
    documentController?.updateLayerMetadata(id, update);
    syncDocumentState();
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

  export async function exportAsPng() {
    if (!renderer) {
      throw new Error("Canvas is not ready to export yet.");
    }

    flushPendingWorkForExport();
    const blob = await renderer.readCompositeAsPngBlob();
    downloadBlob(blob, makeExportFilename());
  }

  export function newProject(width = DEFAULT_CANVAS_WIDTH, height = DEFAULT_CANVAS_HEIGHT) {
    if (!renderer) throw new Error("Canvas is not ready to create a new project yet.");

    const nextWidth = Math.round(clamp(width, MIN_CANVAS_SIZE, MAX_CANVAS_SIZE));
    const nextHeight = Math.round(clamp(height, MIN_CANVAS_SIZE, MAX_CANVAS_SIZE));

    renderer.cancelScheduledFrame();
    resetInteractionState();
    renderer.clearStamps();
    clearHistory();
    toolMode = "brush";

    documentWidth = nextWidth;
    documentHeight = nextHeight;
    renderer.resizeDocument(documentWidth, documentHeight);

    const initialLayer = documentController!.createLayer({ name: "Layer 1" });
    replaceLayers([initialLayer], initialLayer.id);
    fitToScreen();
    scheduleFrame();
  }

  export async function saveProject() {
    if (!renderer) throw new Error("Canvas is not ready to save yet.");

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
          pixels: await renderer.readLayerPixels(layer),
        })),
      ),
    });
  }

  export async function loadProject(blob: Blob) {
    if (!renderer) throw new Error("Canvas is not ready to open a project yet.");

    renderer.cancelScheduledFrame();
    resetInteractionState();
    renderer.clearStamps();

    const { manifest, layers: decodedLayers } = await decodeProjectBlob(blob);
    const loadedLayers: PaintLayer[] = [];
    resetInteractionState();
    renderer.clearStamps();
    clearHistory();
    documentWidth = manifest.canvas.width;
    documentHeight = manifest.canvas.height;
    renderer.resizeDocument(documentWidth, documentHeight);

    try {
      for (const decodedLayer of decodedLayers) {
        const layer = documentController!.createLayer(decodedLayer.metadata);
        renderer.uploadLayerPixels(layer, decodedLayer.pixels);
        loadedLayers.push(layer);
      }
    } catch (e) {
      for (const layer of loadedLayers) {
        destroyLayer(layer);
      }
      throw e;
    }

    replaceLayers(loadedLayers, manifest.activeLayerId);
    documentController?.updateNextLayerNumber();
    syncDocumentState();
    zoom = clamp(manifest.view.zoom, MIN_ZOOM, MAX_ZOOM);
    offsetX = manifest.view.offsetX;
    offsetY = manifest.view.offsetY;
    color = manifest.brush.color;
    brushSize = clamp(Math.round(manifest.brush.size), 1, MAX_BRUSH_SIZE);
    toolMode = "brush";
    hasFitInitialView = true;
    scheduleFrame();
    return { width: documentWidth, height: documentHeight };
  }

  function queueStamp(
    x: number,
    y: number,
    radius: number,
    rgba: Rgba,
    mode: ToolMode,
  ) {
    syncRendererViewState();
    const queued = renderer?.queueStamp(x, y, radius, rgba, mode) ?? false;
    if (!queued) return false;

    if (isDrawing) strokeHistory.markPainted();
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
    mode: ToolMode,
  ) {
    syncRendererViewState();
    const queued = renderer?.stampLine({ x1, y1, r1, o1, x2, y2, r2, o2, rgba, mode }) ?? false;
    if (!queued) return;

    if (isDrawing) strokeHistory.markPainted();
  }

  // ====================================================================
  //  WebGPU initialisation
  // ====================================================================

  $effect(() => {
    const canvas = canvasEl;
    if (!canvas) return;

    let cancelled = false;

    async function init() {
      const resources = await initializeGpuCanvas({
        canvas,
        documentWidth,
        documentHeight,
        brushStampUrl,
        isCancelled: () => cancelled,
      });
      if (!resources) return;

      renderer = new GpuPaintRenderer(resources, documentWidth, documentHeight, {
        getLayers: () => layers,
        getActiveLayer,
        onPaintRendered: () => {
          strokeHistory.markPainted();
        },
        onFrameComplete: finalizePendingPaintHistory,
      });

      documentController = new PaintDocumentController(renderer);
      documentController.setInitialLayer(renderer.initialLayer);
      syncDocumentState();
      markCompositeDirty();

      if (canvasWidth > 0 && canvasHeight > 0) {
        scheduleFrame();
      }
    }

    init().catch((e) => {
      console.error(e);
      error = e instanceof Error ? e.message : "Failed to initialize WebGPU.";
    });

    return () => {
      cancelled = true;
      if (eyedropperRafId !== null) {
        cancelAnimationFrame(eyedropperRafId);
        eyedropperRafId = null;
      }
      documentController?.dispose();
      renderer?.dispose();
      strokeHistory.clear();
      documentController = null;
      renderer = null;
      layers = [];
      layerList = [];
      activeLayerId = null;
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
          } else if (renderer) {
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
    if (!renderer || !canvasEl) return;

    isEyedropperReading = true;

    try {
      const rect = canvasEl.getBoundingClientRect();
      const cssX = screenX - rect.left;
      const cssY = screenY - rect.top;
      const { x, y } = screenToCanvas(cssX, cssY);
      const docX = Math.floor(clamp(x, 0, documentWidth - 1));
      const docY = Math.floor(clamp(y, 0, documentHeight - 1));

      flushPendingWorkForExport();

      color = await renderer.readCompositePixelAsHex(docX, docY);
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
      if (!renderer || !activeLayer || !activeLayer.visible || activeLayer.locked) return;

      if (toolMode === "smudge") flushPendingWorkForExport();

      isDrawing = true;
      strokeToolMode = toolMode;
      strokeUsesPressure = hasRealPressure(e);
      strokeHistory.begin(
        activeLayer.id,
        renderer.copyTexture(activeLayer.texture, "Paint stroke before snapshot"),
      );

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const { x, y } = screenToCanvas(screenX, screenY);
      const radius = getBrushRadius(e, brushSize, strokeUsesPressure, getMinimumPressureRadius(brushSize));
      const opacity = getBrushOpacity(e, strokeUsesPressure, getMinimumPressureOpacity());
      const rgba = hexToVec4(color);
      lastPoint = { x, y, radius, opacity };
      renderer.stampDistanceSinceLastStamp = 0;
      if (strokeToolMode === "smudge") {
        renderer.beginSmudgeStroke(activeLayer, x, y);
      } else {
        queueStamp(x, y, radius, withAlpha(rgba, opacity), strokeToolMode);
      }
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
      strokeToolMode,
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
    if (renderer) renderer.stampDistanceSinceLastStamp = 0;
    cancelEyedropperSample();
    updateBrushPreview(e);

    if (wasDrawing) {
      strokeHistory.requestSaveAfterFrame();
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
    if (renderer) renderer.stampDistanceSinceLastStamp = 0;
    cancelEyedropperSample();
    brushPreviewVisible = false;

    if (wasDrawing) {
      strokeHistory.requestSaveAfterFrame();
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
    function zoomAroundCenter(factor: number) {
      const cw = canvasEl?.clientWidth ?? documentWidth;
      const ch = canvasEl?.clientHeight ?? documentHeight;
      applyZoom(factor, cw / 2, ch / 2);
    }

    function onKeyDown(e: KeyboardEvent) {
      const command = getKeyDownShortcutCommand(e);
      if (!command) return;

      e.preventDefault();
      if (command === "space-down") isSpaceHeld = true;
      else if (command === "eyedropper-down") isEyedropperHeld = true;
      else if (command === "brush-mode") toolMode = "brush";
      else if (command === "eraser-mode") toolMode = "eraser";
      else if (command === "smudge-mode") toolMode = "smudge";
      else if (command === "add-layer") addLayer();
      else if (command === "zoom-in") zoomAroundCenter(1.25);
      else if (command === "zoom-out") zoomAroundCenter(0.8);
      else if (command === "fit-screen") fitToScreen();
      else if (command === "zoom-100") zoomTo100();
      else if (command === "undo") undo();
      else if (command === "redo") redo();
    }

    function onKeyUp(e: KeyboardEvent) {
      const command = getKeyUpShortcutCommand(e);
      if (!command) return;

      e.preventDefault();
      if (command === "space-up") {
        isSpaceHeld = false;
      } else if (command === "eyedropper-up") {
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
    <BrushPreview
      x={brushPreviewX}
      y={brushPreviewY}
      width={brushPreviewWidth}
      height={brushPreviewHeight}
      maskUrl={brushStampOutlineUrl}
    />
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

  <CanvasStatus {zoom} {brushSize} {toolMode} />
</div>
