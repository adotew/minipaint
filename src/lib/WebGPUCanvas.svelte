<script lang="ts">
  /// <reference types="@webgpu/types" />

  import stampShaderCode from "./shaders/stamp.wgsl?raw";
  import blitShaderCode from "./shaders/blit.wgsl?raw";
  import brushStampUrl from "../assets/charcoal-removebg-preview.png";
  import brushStampOutlineUrl from "../assets/charcoal-removebg-preview.png";

  interface Props {
    color: string;
    brushSize: number;
  }

  let { color, brushSize = $bindable() }: Props = $props();

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
  let paintTexture: GPUTexture | null = $state(null);
  let brushStampTexture: GPUTexture | null = $state(null);
  let stampBuffer: GPUBuffer | null = $state(null);
  let stampUniformBuffer: GPUBuffer | null = $state(null);
  let viewUniformBuffer: GPUBuffer | null = $state(null);
  let stampPipeline: GPURenderPipeline | null = $state(null);
  let renderPipeline: GPURenderPipeline | null = $state(null);
  let stampBindGroup: GPUBindGroup | null = $state(null);
  let renderBindGroup: GPUBindGroup | null = $state(null);

  // ---- undo / redo state ----
  let historyTextures: GPUTexture[] = [];
  let historyIndex = -1;
  let shouldSaveHistoryAfterFrame = false;

  // ---- drawing state ----
  let isDrawing = false;
  let strokeUsesPressure = false;
  let lastPoint = { x: 0, y: 0, radius: 0, opacity: 1 };
  let distanceSinceLastStamp = 0;

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

  function clearPaintToWhite(dev: GPUDevice, tex: GPUTexture) {
    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: tex.createView(),
          loadOp: "clear",
          clearValue: [1, 1, 1, 1],
          storeOp: "store",
        },
      ],
    });
    pass.end();
    dev.queue.submit([encoder.finish()]);
  }

  function createHistorySnapshot(dev: GPUDevice, source: GPUTexture) {
    const snapshot = dev.createTexture({
      size: [CANVAS_WIDTH, CANVAS_HEIGHT],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING,
    });

    const encoder = dev.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: source },
      { texture: snapshot },
      [CANVAS_WIDTH, CANVAS_HEIGHT],
    );
    dev.queue.submit([encoder.finish()]);

    return snapshot;
  }

  function restoreHistorySnapshot(dev: GPUDevice, target: GPUTexture, snapshot: GPUTexture) {
    const encoder = dev.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: snapshot },
      { texture: target },
      [CANVAS_WIDTH, CANVAS_HEIGHT],
    );
    dev.queue.submit([encoder.finish()]);
  }

  function saveHistoryState() {
    if (!device || !paintTexture) return;

    // Discard any redo branches before saving a new state.
    while (historyTextures.length > historyIndex + 1) {
      historyTextures.pop()?.destroy();
    }

    const snapshot = createHistorySnapshot(device, paintTexture);
    historyTextures.push(snapshot);
    historyIndex++;

    while (historyTextures.length > MAX_HISTORY_DEPTH) {
      historyTextures.shift()?.destroy();
      historyIndex--;
    }
  }

  export function undo() {
    if (!device || !paintTexture || historyIndex <= 0) return;

    // Cancel any pending frame and discard an in-progress stroke.
    shouldSaveHistoryAfterFrame = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    flushFrame();

    historyIndex--;
    restoreHistorySnapshot(device, paintTexture, historyTextures[historyIndex]);

    isDrawing = false;
    isPanning = false;
    isResizingBrush = false;
    strokeUsesPressure = false;
    distanceSinceLastStamp = 0;
    scheduleFrame();
  }

  export function redo() {
    if (!device || !paintTexture || historyIndex >= historyTextures.length - 1) return;

    shouldSaveHistoryAfterFrame = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    flushFrame();

    historyIndex++;
    restoreHistorySnapshot(device, paintTexture, historyTextures[historyIndex]);

    isDrawing = false;
    isPanning = false;
    isResizingBrush = false;
    strokeUsesPressure = false;
    distanceSinceLastStamp = 0;
    scheduleFrame();
  }

  function cancelScheduledFrame() {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  function flushPendingWorkForExport() {
    cancelScheduledFrame();

    const maxFlushes = Math.ceil(pendingStamps.length / MAX_STAMPS_PER_FRAME) + 1;
    let flushes = 0;
    while (pendingStamps.length > 0) {
      if (flushes > maxFlushes) {
        throw new Error("Could not flush pending paint data before export.");
      }
      flushFrame();
      cancelScheduledFrame();
      flushes++;
    }

    if (shouldSaveHistoryAfterFrame) {
      flushFrame();
      cancelScheduledFrame();
    }
  }

  export async function exportAsPng() {
    if (!device || !paintTexture) {
      throw new Error("Canvas is not ready to export yet.");
    }

    flushPendingWorkForExport();
    const blob = await readTextureAsPngBlob(device, paintTexture);
    downloadBlob(blob, makeExportFilename());
  }

  /**
   * Process queued stamps with alpha blending, then blit the paint texture to
   * the visible canvas. Stamps are rendered as instanced textured quads so
   * pressure opacity can build up naturally through fixed-function blending.
   */
  function flushFrame() {
    if (
      !device ||
      !context ||
      !paintTexture ||
      !stampBuffer ||
      !viewUniformBuffer ||
      !stampPipeline ||
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

    if (n === 0) {
      // No stamps — still need to render for pan/zoom updates
      const encoder = device.createCommandEncoder();

      // Update view uniforms
      writeViewUniforms(device);

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

      device.queue.submit([encoder.finish()]);

      if (shouldSaveHistoryAfterFrame) {
        saveHistoryState();
        shouldSaveHistoryAfterFrame = false;
      }

      if (pendingStamps.length > 0) {
        scheduleFrame();
      } else {
        rafId = null;
      }
      return;
    }

    // Clamp to MAX_STAMPS_PER_FRAME and keep overflow for the next frame.
    const count = Math.min(n, MAX_STAMPS_PER_FRAME);
    if (n > count) {
      pendingStamps = stamps.slice(count).concat(pendingStamps);
    }

    // Fill stamp buffer with all stamp data.
    // Each stamp is 12 f32 values (48 bytes): center.xy, halfSize.xy, color, bounds.
    // Bounds are kept for the existing layout but are not used by render stamping.
    for (let i = 0; i < count; i++) {
      const s = stamps[i];
      const { minX, maxX, minY, maxY, halfWidth, halfHeight } = getStampBounds(s.x, s.y, s.radius);

      const offset = i * FLOATS_PER_STAMP;
      stampDataView[offset + 0] = s.x;
      stampDataView[offset + 1] = s.y;
      stampDataView[offset + 2] = halfWidth;
      stampDataView[offset + 3] = halfHeight;
      stampDataView[offset + 4] = s.rgba[0];
      stampDataView[offset + 5] = s.rgba[1];
      stampDataView[offset + 6] = s.rgba[2];
      stampDataView[offset + 7] = s.rgba[3];
      stampDataView[offset + 8] = minX;
      stampDataView[offset + 9] = minY;
      stampDataView[offset + 10] = maxX;
      stampDataView[offset + 11] = maxY;
    }

    // Single write of all stamp data.
    device.queue.writeBuffer(stampBuffer, 0, stampDataView, 0, count * FLOATS_PER_STAMP);

    // Update view uniforms.
    writeViewUniforms(device);

    const encoder = device.createCommandEncoder();

    // Stamp into the full-resolution paint texture with alpha blending.
    const stampPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: paintTexture.createView(),
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    stampPass.setPipeline(stampPipeline);
    stampPass.setBindGroup(0, stampBindGroup);
    stampPass.draw(6, count);
    stampPass.end();

    // Blit the updated paint texture to the visible canvas.
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

    device.queue.submit([encoder.finish()]);

    // Continue if more stamps arrived during processing
    if (pendingStamps.length > 0) {
      scheduleFrame();
    } else {
      if (shouldSaveHistoryAfterFrame) {
        saveHistoryState();
        shouldSaveHistoryAfterFrame = false;
      }
      rafId = null;
    }
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
      return;
    }

    pendingStamps.push({ x, y, radius, rgba });
    scheduleFrame();
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

      const paintTex = dev.createTexture({
        size: [CANVAS_WIDTH, CANVAS_HEIGHT],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });

      const brushBitmap = await loadBrushStampBitmap();
      if (cancelled) {
        brushBitmap.close?.();
        paintTex.destroy();
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

      // ---- Render pipeline (stamp into paint texture) ----
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
          { binding: 1, resource: paintTex.createView() },
          { binding: 2, resource: { buffer: viewUbo } },
        ],
      });

      // Store refs
      device = dev;
      context = ctx;
      paintTexture = paintTex;
      brushStampTexture = brushTex;
      stampBuffer = brushBuf;
      stampUniformBuffer = stampUbo;
      viewUniformBuffer = viewUbo;
      stampPipeline = stmpPipeline;
      renderPipeline = rndrPipeline;
      stampBindGroup = stmpBindGroup;
      renderBindGroup = rndrBindGroup;

      clearPaintToWhite(dev, paintTex);
      saveHistoryState();

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
      paintTexture?.destroy();
      brushStampTexture?.destroy();
      stampBuffer?.destroy();
      stampUniformBuffer?.destroy();
      viewUniformBuffer?.destroy();
      for (const tex of historyTextures) {
        tex.destroy();
      }
      historyTextures = [];
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
      isDrawing = true;
      strokeUsesPressure = hasRealPressure(e);
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
    isDrawing = false;
    strokeUsesPressure = false;
    distanceSinceLastStamp = 0;
    brushPreviewVisible = false;
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
      if (e.code === "Space" && !e.repeat) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        isSpaceHeld = true;
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

  <div class="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
    {Math.round(zoom * 100)}% · {brushSize}px
  </div>
</div>
