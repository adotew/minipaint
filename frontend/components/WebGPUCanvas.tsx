/// <reference types="@webgpu/types" />

import { useEffect, useRef, useState } from "react";
import stampShaderCode from "../shaders/stamp.wgsl?raw";
import blitShaderCode from "../shaders/blit.wgsl?raw";

const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 400;

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

  const deviceRef = useRef<GPUDevice | null>(null);
  const contextRef = useRef<GPUCanvasContext | null>(null);
  const paintTextureRef = useRef<GPUTexture | null>(null);
  const uniformBufferRef = useRef<GPUBuffer | null>(null);
  const computePipelineRef = useRef<GPUComputePipeline | null>(null);
  const renderPipelineRef = useRef<GPURenderPipeline | null>(null);
  const computeBindGroupRef = useRef<GPUBindGroup | null>(null);
  const renderBindGroupRef = useRef<GPUBindGroup | null>(null);

  const isDrawingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

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
    ) {
      return;
    }

    const minX = Math.max(0, Math.floor(x - radius));
    const maxX = Math.min(CANVAS_WIDTH - 1, Math.ceil(x + radius));
    const minY = Math.max(0, Math.floor(y - radius));
    const maxY = Math.min(CANVAS_HEIGHT - 1, Math.ceil(y + radius));

    if (minX > maxX || minY > maxY) return;

    const uniforms = new Float32Array([
      x,
      y,
      radius,
      0,
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

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    isDrawingRef.current = true;
    lastPosRef.current = { x, y };
    stamp(x, y, brushSize / 2, hexToVec4(color));
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;

    stampLine(lastPosRef.current.x, lastPosRef.current.y, x, y, brushSize / 2, hexToVec4(color));
    lastPosRef.current = { x, y };
  }

  function handlePointerUp() {
    isDrawingRef.current = false;
  }

  function handlePointerLeave() {
    isDrawingRef.current = false;
  }

  return (
    <div className="relative">
      {error && (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-zinc-900/90 p-4 text-center text-sm text-white">
          {error}
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="bg-white rounded-md"
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      />
    </div>
  );
}
