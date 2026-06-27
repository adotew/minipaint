<script lang="ts">
  /// <reference types="@webgpu/types" />

  import stampShaderCode from "./shaders/stamp.wgsl?raw";
  import blitShaderCode from "./shaders/blit.wgsl?raw";

  interface Props {
    color: string;
    brushSize: number;
  }

  let { color, brushSize }: Props = $props();

  const CANVAS_WIDTH = 4000;
  const CANVAS_HEIGHT = 4000;
  const MIN_ZOOM = 0.01;
  const MAX_ZOOM = 32;
  const MAX_STAMPS_PER_FRAME = 1024;
  const MIN_PRESSURE_SIZE = 0.45;
  const PRESSURE_FALLBACK = 0.5;
  const PRESSURE_EPSILON = 0.001;

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
  let brushPreviewSize = $derived(Math.max(1, brushPreviewRadius * 2 * zoom));

  // ---- WebGPU refs ----
  let device: GPUDevice | null = $state(null);
  let context: GPUCanvasContext | null = $state(null);
  let paintTexture: GPUTexture | null = $state(null);
  let stampBuffer: GPUBuffer | null = $state(null);
  let viewUniformBuffer: GPUBuffer | null = $state(null);
  let computePipeline: GPUComputePipeline | null = $state(null);
  let renderPipeline: GPURenderPipeline | null = $state(null);
  let computeBindGroup: GPUBindGroup | null = $state(null);
  let renderBindGroup: GPUBindGroup | null = $state(null);

  // ---- drawing state ----
  let isDrawing = false;
  let strokeUsesPressure = false;
  let lastPoint = { x: 0, y: 0, radius: 0 };

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
  let maxStampW = 0;
  let maxStampH = 0;
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

  function screenToCanvas(screenX: number, screenY: number) {
    return {
      x: screenX / zoom + offsetX,
      y: screenY / zoom + offsetY,
    };
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

  /**
   * Process all queued stamps in a single compute dispatch (storage buffer)
   * plus one render pass → one GPU submit.
   */
  function flushFrame() {
    if (
      !device ||
      !context ||
      !stampBuffer ||
      !viewUniformBuffer ||
      !computePipeline ||
      !renderPipeline ||
      !computeBindGroup ||
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
    const stampW = maxStampW;
    const stampH = maxStampH;
    maxStampW = 0;
    maxStampH = 0;

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
      const overflow = stamps.slice(count);
      pendingStamps = overflow.concat(pendingStamps);
      for (const s of overflow) {
        const minX = Math.max(0, Math.floor(s.x - s.radius));
        const maxX = Math.min(CANVAS_WIDTH - 1, Math.ceil(s.x + s.radius));
        const minY = Math.max(0, Math.floor(s.y - s.radius));
        const maxY = Math.min(CANVAS_HEIGHT - 1, Math.ceil(s.y + s.radius));
        maxStampW = Math.max(maxStampW, maxX - minX + 1);
        maxStampH = Math.max(maxStampH, maxY - minY + 1);
      }
    }

    // Fill stamp buffer with all stamp data
    // Each stamp is 12 f32 values (48 bytes): center.xy, radius, pad1, color, bounds
    for (let i = 0; i < count; i++) {
      const s = stamps[i];
      const minX = Math.max(0, Math.floor(s.x - s.radius));
      const maxX = Math.min(CANVAS_WIDTH - 1, Math.ceil(s.x + s.radius));
      const minY = Math.max(0, Math.floor(s.y - s.radius));
      const maxY = Math.min(CANVAS_HEIGHT - 1, Math.ceil(s.y + s.radius));

      const offset = i * 12;
      stampDataView[offset + 0] = s.x;
      stampDataView[offset + 1] = s.y;
      stampDataView[offset + 2] = s.radius;
      stampDataView[offset + 3] = 0; // pad1
      stampDataView[offset + 4] = s.rgba[0];
      stampDataView[offset + 5] = s.rgba[1];
      stampDataView[offset + 6] = s.rgba[2];
      stampDataView[offset + 7] = s.rgba[3];
      stampDataView[offset + 8] = minX;
      stampDataView[offset + 9] = minY;
      stampDataView[offset + 10] = maxX;
      stampDataView[offset + 11] = maxY;
    }

    // Single write of all stamp data
    device.queue.writeBuffer(stampBuffer, 0, stampDataView, 0, count * 12);

    // Update view uniforms
    writeViewUniforms(device);

    const encoder = device.createCommandEncoder();

    // Single compute pass, one 3D dispatch
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(computePipeline);
    computePass.setBindGroup(0, computeBindGroup);
    computePass.dispatchWorkgroups(
      Math.max(1, Math.ceil(stampW / 8)),
      Math.max(1, Math.ceil(stampH / 8)),
      count,
    );
    computePass.end();

    // Single render pass
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
    if (
      x + radius < 0 ||
      y + radius < 0 ||
      x - radius >= CANVAS_WIDTH ||
      y - radius >= CANVAS_HEIGHT
    ) {
      return;
    }

    const minX = Math.max(0, Math.floor(x - radius));
    const maxX = Math.min(CANVAS_WIDTH - 1, Math.ceil(x + radius));
    const minY = Math.max(0, Math.floor(y - radius));
    const maxY = Math.min(CANVAS_HEIGHT - 1, Math.ceil(y + radius));

    if (maxX < minX || maxY < minY) return;

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;

    pendingStamps.push({ x, y, radius, rgba });
    if (w > maxStampW) maxStampW = w;
    if (h > maxStampH) maxStampH = h;
    scheduleFrame();
  }

  function stampLine(
    x1: number,
    y1: number,
    r1: number,
    x2: number,
    y2: number,
    r2: number,
    rgba: [number, number, number, number],
  ) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) {
      queueStamp(x1, y1, r2, rgba);
      return;
    }

    // Include the starting point for gapless chaining
    queueStamp(x1, y1, r1, rgba);

    const step = Math.max(1, Math.max(r1, r2) * 0.5);
    const steps = Math.ceil(dist / step);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const radius = r1 + (r2 - r1) * t;
      queueStamp(x1 + dx * t, y1 + dy * t, radius, rgba);
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
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      const sampler = dev.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
      });

      // Storage buffer for stamp data (12 f32 × MAX_STAMPS_PER_FRAME)
      const brushBufSize = 12 * MAX_STAMPS_PER_FRAME * 4; // f32 = 4 bytes
      const brushBuf = dev.createBuffer({
        size: brushBufSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Pre-allocate CPU-side view for filling stamp data
      stampDataView = new Float32Array(12 * MAX_STAMPS_PER_FRAME);

      // View uniforms (32 bytes)
      const viewUbo = dev.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // ---- Compute pipeline (stamp) ----
      const computeBindGroupLayout = dev.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: {
              access: "write-only",
              format: "rgba8unorm",
              viewDimension: "2d",
            },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "read-only-storage" },
          },
        ],
      });

      const compPipeline = dev.createComputePipeline({
        layout: dev.createPipelineLayout({
          bindGroupLayouts: [computeBindGroupLayout],
        }),
        compute: {
          module: dev.createShaderModule({ code: stampShaderCode }),
          entryPoint: "stamp",
        },
      });

      const compBindGroup = dev.createBindGroup({
        layout: computeBindGroupLayout,
        entries: [
          { binding: 0, resource: paintTex.createView() },
          { binding: 1, resource: { buffer: brushBuf } },
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
          { binding: 0, resource: sampler },
          { binding: 1, resource: paintTex.createView() },
          { binding: 2, resource: { buffer: viewUbo } },
        ],
      });

      // Store refs
      device = dev;
      context = ctx;
      paintTexture = paintTex;
      stampBuffer = brushBuf;
      viewUniformBuffer = viewUbo;
      computePipeline = compPipeline;
      renderPipeline = rndrPipeline;
      computeBindGroup = compBindGroup;
      renderBindGroup = rndrBindGroup;

      clearPaintToWhite(dev, paintTex);

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
      stampBuffer?.destroy();
      viewUniformBuffer?.destroy();
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

    if (e.button === 0) {
      isDrawing = true;
      strokeUsesPressure = hasRealPressure(e);
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const { x, y } = screenToCanvas(screenX, screenY);
      const radius = getRadius(e, brushSize * MIN_PRESSURE_SIZE / 2);
      lastPoint = { x, y, radius };
      queueStamp(x, y, radius, hexToVec4(color));
      canvas.setPointerCapture(e.pointerId);
    }
  }

  function handlePointerMove(e: PointerEvent) {
    updateBrushPreview(e);

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
    stampLine(lastPoint.x, lastPoint.y, lastPoint.radius, x, y, radius, hexToVec4(color));
    lastPoint = { x, y, radius };
  }

  function handlePointerUp(e: PointerEvent) {
    isDrawing = false;
    isPanning = false;
    strokeUsesPressure = false;
    updateBrushPreview(e);
    try {
      canvasEl?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function handlePointerLeave() {
    isDrawing = false;
    strokeUsesPressure = false;
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
      const pressureScale = MIN_PRESSURE_SIZE + (1 - MIN_PRESSURE_SIZE) * Math.min(1, p);
      return brushSize * pressureScale / 2;
    }

    return fallbackRadius;
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
      class="pointer-events-none absolute rounded-full border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
      style="left: {brushPreviewX}px; top: {brushPreviewY}px; width: {brushPreviewSize}px; height: {brushPreviewSize}px; transform: translate(-50%, -50%);"
    ></div>
  {/if}

  <div class="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white/90 font-mono">
    {Math.round(zoom * 100)}%
  </div>
</div>
