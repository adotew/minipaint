<script lang="ts">
  /// <reference types="@webgpu/types" />

  import stampShaderCode from "./shaders/stamp.wgsl?raw";
  import blitShaderCode from "./shaders/blit.wgsl?raw";

  interface Props {
    color: string;
    brushSize: number;
  }

  let { color, brushSize }: Props = $props();

  const CANVAS_WIDTH = 600;
  const CANVAS_HEIGHT = 400;
  const MIN_ZOOM = 0.01;
  const MAX_ZOOM = 32;

  // ---- DOM binding ----
  let canvasEl: HTMLCanvasElement | undefined = $state();
  let error = $state<string | null>(null);

  // ---- zoom / pan state ----
  let zoom = $state(1);
  let offsetX = $state(0);
  let offsetY = $state(0);
  let isPanning = $state(false);
  let isSpaceHeld = $state(false);

  // ---- CSS transform (computed from DOM size + zoom/offset) ----
  let canvasTransform = $state("scale(1)");
  let imageRenderHint = $state("auto");

  $effect(() => {
    const cw = canvasEl?.clientWidth ?? CANVAS_WIDTH;
    const ch = canvasEl?.clientHeight ?? CANVAS_HEIGHT;
    canvasTransform = `scale(${zoom}) translate(${-offsetX * cw / CANVAS_WIDTH}px, ${-offsetY * ch / CANVAS_HEIGHT}px)`;
    imageRenderHint = zoom < 1 ? "auto" : "pixelated";
  });

  // ---- cursor ----
  let cursor = $derived(
    isPanning ? "grabbing" : isSpaceHeld ? "grab" : "crosshair"
  );

  // ---- WebGPU refs ----
  let device: GPUDevice | null = $state(null);
  let context: GPUCanvasContext | null = $state(null);
  let paintTexture: GPUTexture | null = $state(null);
  let uniformBuffer: GPUBuffer | null = $state(null);
  let computePipeline: GPUComputePipeline | null = $state(null);
  let renderPipeline: GPURenderPipeline | null = $state(null);
  let computeBindGroup: GPUBindGroup | null = $state(null);
  let renderBindGroup: GPUBindGroup | null = $state(null);

  // ---- drawing state ----
  let isDrawing = false;
  let lastPos = { x: 0, y: 0 };

  // ---- pan tracking ----
  let panStart = { clientX: 0, clientY: 0, offsetX: 0, offsetY: 0 };

  // ---- wheel accumulator ----
  let wheelAccum = 0;

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

  function getCanvasSize() {
    return {
      w: canvasEl?.clientWidth ?? CANVAS_WIDTH,
      h: canvasEl?.clientHeight ?? CANVAS_HEIGHT,
    };
  }

  function screenToCanvas(screenX: number, screenY: number) {
    const { w: cw, h: ch } = getCanvasSize();
    return {
      x: (screenX * CANVAS_WIDTH) / (zoom * cw),
      y: (screenY * CANVAS_HEIGHT) / (zoom * ch),
    };
  }

  // ====================================================================
  //  WebGPU helpers
  // ====================================================================

  function clearToGray(dev: GPUDevice, tex: GPUTexture) {
    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: tex.createView(),
          loadOp: "clear",
          clearValue: [0.5, 0.5, 0.5, 1],
          storeOp: "store",
        },
      ],
    });
    pass.end();
    dev.queue.submit([encoder.finish()]);
  }

  function present(
    dev: GPUDevice,
    ctx: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
  ) {
    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: [0, 0, 0, 0],
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    dev.queue.submit([encoder.finish()]);
  }

  function stamp(
    x: number,
    y: number,
    radius: number,
    rgba: [number, number, number, number],
  ) {
    if (
      !device ||
      !context ||
      !uniformBuffer ||
      !computePipeline ||
      !renderPipeline ||
      !computeBindGroup ||
      !renderBindGroup
    )
      return;

    const minX = Math.max(0, Math.floor(x - radius));
    const maxX = Math.min(CANVAS_WIDTH - 1, Math.ceil(x + radius));
    const minY = Math.max(0, Math.floor(y - radius));
    const maxY = Math.min(CANVAS_HEIGHT - 1, Math.ceil(y + radius));

    if (minX > maxX || minY > maxY) return;

    const uniforms = new Float32Array([
      x, y, radius, 0,
      rgba[0], rgba[1], rgba[2], rgba[3],
      minX, minY, maxX, maxY,
    ]);
    device.queue.writeBuffer(uniformBuffer, 0, uniforms);

    const textureView = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();

    const computePass = encoder.beginComputePass();
    computePass.setPipeline(computePipeline);
    computePass.setBindGroup(0, computeBindGroup);
    computePass.dispatchWorkgroups(
      Math.ceil((maxX - minX + 1) / 8),
      Math.ceil((maxY - minY + 1) / 8),
    );
    computePass.end();

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          loadOp: "clear",
          clearValue: [0, 0, 0, 0],
          storeOp: "store",
        },
      ],
    });
    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, renderBindGroup);
    renderPass.draw(3);
    renderPass.end();

    device.queue.submit([encoder.finish()]);
  }

  function stampLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    radius: number,
    rgba: [number, number, number, number],
  ) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;

    const step = Math.max(1, radius * 0.5);
    const steps = Math.ceil(dist / step);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      stamp(x1 + dx * t, y1 + dy * t, radius, rgba);
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

      const ubo = dev.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

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
            buffer: { type: "uniform" },
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
          { binding: 1, resource: { buffer: ubo } },
        ],
      });

      const renderBindGroupLayout = dev.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
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
        ],
      });

      // Store refs
      device = dev;
      context = ctx;
      paintTexture = paintTex;
      uniformBuffer = ubo;
      computePipeline = compPipeline;
      renderPipeline = rndrPipeline;
      computeBindGroup = compBindGroup;
      renderBindGroup = rndrBindGroup;

      clearToGray(dev, paintTex);
      present(dev, ctx, rndrPipeline, rndrBindGroup);
    }

    init().catch((e) => {
      console.error(e);
      error = "Failed to initialize WebGPU.";
    });

    return () => {
      cancelled = true;
      paintTexture?.destroy();
      uniformBuffer?.destroy();
    };
  });

  // ====================================================================
  //  Zoom helpers
  // ====================================================================

  function applyZoom(factor: number, cursorX: number, cursorY: number) {
    const oldZoom = zoom;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
    if (newZoom === oldZoom) return;

    const { w: cw, h: ch } = getCanvasSize();
    const newOffsetX = offsetX + cursorX * CANVAS_WIDTH / cw * (1 / oldZoom - 1 / newZoom);
    const newOffsetY = offsetY + cursorY * CANVAS_HEIGHT / ch * (1 / oldZoom - 1 / newZoom);

    zoom = newZoom;
    offsetX = newOffsetX;
    offsetY = newOffsetY;
  }

  function fitToScreen() {
    const canvas = canvasEl;
    if (!canvas) return;
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const scale = Math.min(vw / CANVAS_WIDTH, vh / CANVAS_HEIGHT, 1);
    const ox = (CANVAS_WIDTH - vw / scale) / 2;
    const oy = (CANVAS_HEIGHT - vh / scale) / 2;
    zoom = scale;
    offsetX = -ox;
    offsetY = -oy;
  }

  function zoomTo100() {
    zoom = 1;
    offsetX = 0;
    offsetY = 0;
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

    // Middle-mouse or Space + Left → pan
    if (e.button === 1 || (e.button === 0 && isSpaceHeld)) {
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

    // Left mouse → draw
    if (e.button === 0) {
      isDrawing = true;
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const { x, y } = screenToCanvas(screenX, screenY);
      lastPos = { x, y };

      const radius = getRadius(e);
      stamp(x, y, radius, hexToVec4(color));
      canvas.setPointerCapture(e.pointerId);
    }
  }

  function handlePointerMove(e: PointerEvent) {
    // ---- panning ----
    if (isPanning) {
      const dx = e.clientX - panStart.clientX;
      const dy = e.clientY - panStart.clientY;
      const { w: cw, h: ch } = getCanvasSize();
      offsetX = panStart.offsetX - dx * CANVAS_WIDTH / (zoom * cw);
      offsetY = panStart.offsetY - dy * CANVAS_HEIGHT / (zoom * ch);
      return;
    }

    // ---- drawing ----
    if (!isDrawing) return;

    const canvas = canvasEl;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const { x, y } = screenToCanvas(screenX, screenY);

    const radius = getRadius(e);
    stampLine(lastPos.x, lastPos.y, x, y, radius, hexToVec4(color));
    lastPos = { x, y };
  }

  function handlePointerUp(e: PointerEvent) {
    isDrawing = false;
    isPanning = false;
    try {
      canvasEl?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function handlePointerLeave() {
    isDrawing = false;
  }

  // ====================================================================
  //  Pen pressure — works natively in Electron/Chromium!
  // ====================================================================
  function getRadius(e: PointerEvent): number {
    const p = e.pressure;
    // Mouse always reports 0.5; pen reports 0–1
    if (typeof p === "number" && p !== 0.5 && p > 0.01) {
      return brushSize * Math.max(0.05, p) / 2;
    }
    return brushSize / 2;
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
    class="block h-screen w-screen bg-neutral-400"
    style="transform-origin: 0 0; transform: {canvasTransform}; image-rendering: {imageRenderHint}; cursor: {cursor}"
    width={CANVAS_WIDTH}
    height={CANVAS_HEIGHT}
    onwheel={handleWheel}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointerleave={handlePointerLeave}
    oncontextmenu={(e: MouseEvent) => e.preventDefault()}
  ></canvas>

  <div class="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white/90 font-mono">
    {Math.round(zoom * 100)}%
  </div>
</div>
