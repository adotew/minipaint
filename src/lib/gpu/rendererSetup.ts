import { FLOATS_PER_STAMP, MAX_STAMPS_PER_FRAME } from "../core/constants";
import type { PaintLayer } from "../document/layers";
import { createBrushStampTexture, loadBrushStampBitmap } from "./brushStamp";
import {
  createEyedropperReadBuffer,
  createStampBuffer,
  createStampUniformBuffer,
  createViewUniformBuffer,
} from "./buffers";
import {
  createCompositePipelineResources,
  createStampPipelineResources,
  createViewportPipelineResources,
} from "./pipelines";
import { createDocumentTexture } from "./textures";
import { createPaintLayerResource } from "./layerResources";

export type GpuCanvasResources = {
  device: GPUDevice;
  context: GPUCanvasContext;
  compositeTexture: GPUTexture;
  compositeTextureView: GPUTextureView;
  brushStampTexture: GPUTexture;
  stampBuffer: GPUBuffer;
  stampUniformBuffer: GPUBuffer;
  viewUniformBuffer: GPUBuffer;
  eyedropperReadBuffer: GPUBuffer;
  stampPipeline: GPURenderPipeline;
  eraserStampPipeline: GPURenderPipeline;
  compositePipeline: GPURenderPipeline;
  renderPipeline: GPURenderPipeline;
  stampBindGroup: GPUBindGroup;
  renderBindGroup: GPUBindGroup;
  renderBindGroupLayout: GPUBindGroupLayout;
  paintSampler: GPUSampler;
  compositeBindGroupLayout: GPUBindGroupLayout;
  compositeSampler: GPUSampler;
  stampDataView: Float32Array;
  initialLayer: PaintLayer;
};

export async function initializeGpuCanvas(options: {
  canvas: HTMLCanvasElement;
  documentWidth: number;
  documentHeight: number;
  brushStampUrl: string;
  isCancelled?: () => boolean;
}): Promise<GpuCanvasResources | null> {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available in this browser.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("Could not get a WebGPU adapter.");
  }

  const device = await adapter.requestDevice();
  if (options.isCancelled?.()) {
    device.destroy();
    return null;
  }

  const context = options.canvas.getContext("webgpu");
  if (!context) {
    device.destroy();
    throw new Error("Could not get a WebGPU canvas context.");
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const compositeTexture = createDocumentTexture(
    device,
    options.documentWidth,
    options.documentHeight,
    "Composite texture",
  );
  const compositeTextureView = compositeTexture.createView();

  const brushBitmap = await loadBrushStampBitmap(options.brushStampUrl);
  if (options.isCancelled?.()) {
    brushBitmap.close?.();
    compositeTexture.destroy();
    device.destroy();
    return null;
  }

  const brushStampTexture = createBrushStampTexture(device, brushBitmap);
  brushBitmap.close?.();

  const paintSampler = device.createSampler({
    magFilter: "nearest",
    minFilter: "nearest",
  });
  const brushSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  const compositeSampler = device.createSampler({
    magFilter: "nearest",
    minFilter: "nearest",
  });

  const stampBuffer = createStampBuffer(device);
  const stampDataView = new Float32Array(FLOATS_PER_STAMP * MAX_STAMPS_PER_FRAME);
  const stampUniformBuffer = createStampUniformBuffer(device, options.documentWidth, options.documentHeight);
  const viewUniformBuffer = createViewUniformBuffer(device);
  const eyedropperReadBuffer = createEyedropperReadBuffer(device);

  const stampResources = createStampPipelineResources(
    device,
    brushSampler,
    brushStampTexture.createView(),
    stampBuffer,
    stampUniformBuffer,
  );
  const compositeResources = createCompositePipelineResources(device);
  const viewportResources = createViewportPipelineResources(
    device,
    format,
    paintSampler,
    compositeTextureView,
    viewUniformBuffer,
  );

  const initialLayer = createPaintLayerResource({
    device,
    width: options.documentWidth,
    height: options.documentHeight,
    compositeBindGroupLayout: compositeResources.bindGroupLayout,
    compositeSampler,
    metadata: { name: "Layer 1" },
    fallbackName: "Layer 1",
  });

  return {
    device,
    context,
    compositeTexture,
    compositeTextureView,
    brushStampTexture,
    stampBuffer,
    stampUniformBuffer,
    viewUniformBuffer,
    eyedropperReadBuffer,
    stampPipeline: stampResources.pipeline,
    eraserStampPipeline: stampResources.eraserPipeline,
    compositePipeline: compositeResources.pipeline,
    renderPipeline: viewportResources.pipeline,
    stampBindGroup: stampResources.bindGroup,
    renderBindGroup: viewportResources.bindGroup,
    renderBindGroupLayout: viewportResources.bindGroupLayout,
    paintSampler,
    compositeBindGroupLayout: compositeResources.bindGroupLayout,
    compositeSampler,
    stampDataView,
    initialLayer,
  };
}
