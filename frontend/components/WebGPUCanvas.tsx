/// <reference types="@webgpu/types" />

import { useEffect, useRef, useState, useCallback } from "react";
import stampShaderCode from "../shaders/stamp.wgsl?raw";
import blitShaderCode from "../shaders/blit.wgsl?raw";

const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 400;
const MIN_ZOOM = 0.01;   // 1%
const MAX_ZOOM = 32;      // 3200%

interface WebGPUCanvasProps {
  color: string;
  brushSize: number;
}

function hexToVec4(hex: string): [number, number, number, number] {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return [0, 0, 0, 1];
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return [r, g, b, 1];
}

export default function WebGPUCanvas({ color, brushSize }: WebGPUCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- zoom / pan state ----
  const [zoom, setZoom] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);

  // ref mirrors so event handlers never see stale values
  const zoomRef = useRef(zoom);
  const offsetXRef = useRef(offsetX);
  const offsetYRef = useRef(offsetY);
  const isPanningRef = useRef(isPanning);
  const isSpaceHeldRef = useRef(isSpaceHeld);
  zoomRef.current = zoom;
  offsetXRef.current = offsetX;
  offsetYRef.current = offsetY;
  isPanningRef.current = isPanning;
  isSpaceHeldRef.current = isSpaceHeld;

  // ---- WebGPU refs ----
  const deviceRef = useRef<GPUDevice | null>(null);
  const contextRef = useRef<GPUCanvasContext | null>(null);
  const paintTextureRef = useRef<GPUTexture | null>(null);
  const uniformBufferRef = useRef<GPUBuffer | null>(null);
  const computePipelineRef = useRef<GPUComputePipeline | null>(null);
  const renderPipelineRef = useRef<GPURenderPipeline | null>(null);
  const computeBindGroupRef = useRef<GPUBindGroup | null>(null);
  const renderBindGroupRef = useRef<GPUBindGroup | null>(null);

  // ---- drawing refs ----
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

  // ---- pan tracking refs ----
  const panStartRef = useRef({ clientX: 0, clientY: 0, offsetX: 0, offsetY: 0 });

  // ---- helper: read current canvas CSS dimensions ----
  function getCanvasSize() {
    const c = canvasRef.current;
    return { w: c?.clientWidth ?? CANVAS_WIDTH, h: c?.clientHeight ?? CANVAS_HEIGHT };
  }

  // ---- convert screen coordinates → canvas coordinates ----
  const screenToCanvas = useCallback(
    (screenX: number, screenY: number) => {
      const { w: cw, h: ch } = getCanvasSize();
      return {
        x: screenX * CANVAS_WIDTH / (zoomRef.current * cw),
        y: screenY * CANVAS_HEIGHT / (zoomRef.current * ch),
      };
    },
    [],
  );

  // ====================================================================
  //  WebGPU helpers (unchanged logic)
  // ====================================================================

  function clearToWhite(device: GPUDevice, texture: GPUTexture) {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: "clear",
          clearValue: [1, 1, 1, 1],
          storeOp: "store",
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function present(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
  ) {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
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
    device.queue.submit([encoder.finish()]);
  }

  function stamp(
    x: number,
    y: number,
    radius: number,
    rgba: [number, number, number, number],
  ) {
    const device = deviceRef.current;
    const context = contextRef.current;
    const uniformBuffer = uniformBufferRef.current;
    const computePipeline = computePipelineRef.current;
    const renderPipeline = renderPipelineRef.current;
    const computeBindGroup = computeBindGroupRef.current;
    const renderBindGroup = renderBindGroupRef.current;

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
      x,
      y,
      radius,
      0, // pad
      rgba[0],
      rgba[1],
      rgba[2],
      rgba[3],
      minX,
      minY,
      maxX,
      maxY,
    ]);
    device.queue.writeBuffer(uniformBuffer, 0, uniforms);

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
          view: context.getCurrentTexture().createView(),
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    async function init() {
      if (!navigator.gpu) {
        setError("WebGPU is not available in this browser.");
        return;
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        setError("Could not get a WebGPU adapter.");
        return;
      }

      const device = await adapter.requestDevice();
      if (cancelled) {
        device.destroy();
        return;
      }

      const context = canvas!.getContext("webgpu");
      if (!context) {
        setError("Could not get a WebGPU canvas context.");
        return;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({
        device,
        format,
        alphaMode: "premultiplied",
      });

      const paintTexture = device.createTexture({
        size: [CANVAS_WIDTH, CANVAS_HEIGHT],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      const sampler = device.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
      });

      const uniformBuffer = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });



      const computeBindGroupLayout = device.createBindGroupLayout({
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

      const computePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [computeBindGroupLayout],
        }),
        compute: {
          module: device.createShaderModule({ code: stampShaderCode }),
          entryPoint: "stamp",
        },
      });

      const computeBindGroup = device.createBindGroup({
        layout: computeBindGroupLayout,
        entries: [
          { binding: 0, resource: paintTexture.createView() },
          { binding: 1, resource: { buffer: uniformBuffer } },
        ],
      });

      const renderBindGroupLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        ],
      });

      const renderPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [renderBindGroupLayout],
        }),
        vertex: {
          module: device.createShaderModule({ code: blitShaderCode }),
          entryPoint: "vs",
        },
        fragment: {
          module: device.createShaderModule({ code: blitShaderCode }),
          entryPoint: "fs",
          targets: [{ format }],
        },
        primitive: { topology: "triangle-list" },
      });

      const renderBindGroup = device.createBindGroup({
        layout: renderBindGroupLayout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: paintTexture.createView() },
        ],
      });

      deviceRef.current = device;
      contextRef.current = context;
      paintTextureRef.current = paintTexture;
      uniformBufferRef.current = uniformBuffer;
      computePipelineRef.current = computePipeline;
      renderPipelineRef.current = renderPipeline;
      computeBindGroupRef.current = computeBindGroup;
      renderBindGroupRef.current = renderBindGroup;

      clearToWhite(device, paintTexture);
      present(device, context, renderPipeline, renderBindGroup);
    }

    init().catch((e) => {
      console.error(e);
      setError("Failed to initialize WebGPU.");
    });

    return () => {
      cancelled = true;
      paintTextureRef.current?.destroy();
      uniformBufferRef.current?.destroy();
    };
  }, []);

  // ====================================================================
  //  Zoom helpers
  // ====================================================================

  /** Zoom by a multiplicative factor, keeping the point at (cursorX,cursorY) fixed. */
  const applyZoom = useCallback(
    (factor: number, cursorX: number, cursorY: number) => {
      const oldZoom = zoomRef.current;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
      if (newZoom === oldZoom) return;

      const { w: cw, h: ch } = getCanvasSize();
      const newOffsetX = offsetXRef.current + cursorX * CANVAS_WIDTH / cw * (1 / oldZoom - 1 / newZoom);
      const newOffsetY = offsetYRef.current + cursorY * CANVAS_HEIGHT / ch * (1 / oldZoom - 1 / newZoom);

      zoomRef.current = newZoom;
      offsetXRef.current = newOffsetX;
      offsetYRef.current = newOffsetY;
      setZoom(newZoom);
      setOffsetX(newOffsetX);
      setOffsetY(newOffsetY);
    },
    [],
  );

  /** Fit the whole canvas inside the viewport. */
  const fitToScreen = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const scale = Math.min(vw / CANVAS_WIDTH, vh / CANVAS_HEIGHT, 1);
    const ox = (CANVAS_WIDTH - vw / scale) / 2;
    const oy = (CANVAS_HEIGHT - vh / scale) / 2;
    zoomRef.current = scale;
    offsetXRef.current = -ox;
    offsetYRef.current = -oy;
    setZoom(scale);
    setOffsetX(-ox);
    setOffsetY(-oy);
  }, []);

  /** Reset to 100 % (1:1). */
  const zoomTo100 = useCallback(() => {
    zoomRef.current = 1;
    offsetXRef.current = 0;
    offsetYRef.current = 0;
    setZoom(1);
    setOffsetX(0);
    setOffsetY(0);
  }, []);

  // ====================================================================
  //  Wheel → zoom (centred on cursor)
  // ====================================================================

  // accumulator to debounce high‑resolution scroll (trackpad / Magic Mouse)
  const wheelAccumRef = useRef(0);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      // On macOS pinch-to-zoom fires wheel events with ctrlKey = true.
      // In that case we want to zoom centred on cursor.
      e.preventDefault();

      wheelAccumRef.current += e.deltaY;
      const threshold = 30;
      if (Math.abs(wheelAccumRef.current) < threshold) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      // exponential zoom step – feels natural
      const factor = wheelAccumRef.current < 0 ? 1.1 : 0.9;
      wheelAccumRef.current = 0;
      applyZoom(factor, cursorX, cursorY);
    },
    [applyZoom],
  );

  // ====================================================================
  //  Pointer handlers
  // ====================================================================

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Middle-mouse or Space + Left → pan
      if (e.button === 1 || (e.button === 0 && isSpaceHeldRef.current)) {
        setIsPanning(true);
        isPanningRef.current = true;
        panStartRef.current = {
          clientX: e.clientX,
          clientY: e.clientY,
          offsetX: offsetXRef.current,
          offsetY: offsetYRef.current,
        };
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      // Left mouse → draw
      if (e.button === 0) {
        isDrawingRef.current = true;
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const { x, y } = screenToCanvas(screenX, screenY);
        lastPosRef.current = { x, y };
        stamp(x, y, brushSize / 2, hexToVec4(color));
        canvas.setPointerCapture(e.pointerId);
      }
    },
    [color, brushSize, screenToCanvas],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      // ---- panning ----
      if (isPanningRef.current) {
        const dx = e.clientX - panStartRef.current.clientX;
        const dy = e.clientY - panStartRef.current.clientY;
        const z = zoomRef.current;
        const { w: cw, h: ch } = getCanvasSize();
        const newOffsetX = panStartRef.current.offsetX - dx * CANVAS_WIDTH / (z * cw);
        const newOffsetY = panStartRef.current.offsetY - dy * CANVAS_HEIGHT / (z * ch);
        offsetXRef.current = newOffsetX;
        offsetYRef.current = newOffsetY;
        setOffsetX(newOffsetX);
        setOffsetY(newOffsetY);
        return;
      }

      // ---- drawing ----
      if (!isDrawingRef.current) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const { x, y } = screenToCanvas(screenX, screenY);

      stampLine(
        lastPosRef.current.x,
        lastPosRef.current.y,
        x,
        y,
        brushSize / 2,
        hexToVec4(color),
      );
      lastPosRef.current = { x, y };
    },
    [color, brushSize, screenToCanvas],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      isDrawingRef.current = false;
      if (isPanningRef.current) {
        isPanningRef.current = false;
        setIsPanning(false);
      }
      try {
        canvasRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const handlePointerLeave = useCallback(() => {
    // don't reset panning state if we're dragging out of the canvas
    isDrawingRef.current = false;
  }, []);

  // ====================================================================
  //  Keyboard shortcuts (Space, Ctrl+/-, Ctrl+0)
  // ====================================================================

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Space – activate grab mode (skip when typing in inputs)
      if (e.code === "Space" && !e.repeat) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        isSpaceHeldRef.current = true;
        setIsSpaceHeld(true);
        return;
      }

      // Ctrl/Cmd + Plus  → zoom in
      if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) return;
        const cx = canvas.clientWidth / 2;
        const cy = canvas.clientHeight / 2;
        applyZoom(1.25, cx, cy);
        return;
      }

      // Ctrl/Cmd + Minus → zoom out
      if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) return;
        const cx = canvas.clientWidth / 2;
        const cy = canvas.clientHeight / 2;
        applyZoom(0.8, cx, cy);
        return;
      }

      // Ctrl/Cmd + 0 → fit to screen
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        fitToScreen();
        return;
      }

      // Ctrl/Cmd + 1 → 100 %
      if ((e.ctrlKey || e.metaKey) && e.key === "1") {
        e.preventDefault();
        zoomTo100();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        isSpaceHeldRef.current = false;
        setIsSpaceHeld(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [applyZoom, fitToScreen, zoomTo100]);

  // ====================================================================
  //  Cursor style (derived from state for reactivity)
  // ====================================================================

  const cursor = isPanning
    ? "grabbing"
    : isSpaceHeld
      ? "grab"
      : "crosshair";

  // ====================================================================
  //  Render
  // ====================================================================

  return (
    <div className="relative inline-block select-none">
      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded-md bg-zinc-900/90 p-4 text-center text-sm text-white">
          {error}
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="block h-screen w-screen bg-white"
        style={{
          transformOrigin: "0 0",
          transform: (() => { const { w: cw, h: ch } = getCanvasSize(); return `scale(${zoom}) translate(${-offsetX * cw / CANVAS_WIDTH}px, ${-offsetY * ch / CANVAS_HEIGHT}px)`; })(),
          imageRendering: zoom < 1 ? "auto" : "pixelated",
          cursor,
        }}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Zoom indicator */}
      <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white/90 font-mono">
        {Math.round(zoom * 100)}%
      </div>
    </div>
  );
}
