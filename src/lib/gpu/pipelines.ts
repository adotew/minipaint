import stampShaderCode from "../shaders/stamp.wgsl?raw";
import blitShaderCode from "../shaders/blit.wgsl?raw";
import compositeShaderCode from "../shaders/composite.wgsl?raw";

export type StampPipelineResources = {
  pipeline: GPURenderPipeline;
  eraserPipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
};

export type CompositePipelineResources = {
  bindGroupLayout: GPUBindGroupLayout;
  pipeline: GPURenderPipeline;
};

export type ViewportPipelineResources = {
  bindGroupLayout: GPUBindGroupLayout;
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
};

export function createStampPipelineResources(
  dev: GPUDevice,
  brushSampler: GPUSampler,
  brushTextureView: GPUTextureView,
  stampBuffer: GPUBuffer,
  stampUniformBuffer: GPUBuffer,
): StampPipelineResources {
  const bindGroupLayout = dev.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
    ],
  });

  const pipelineLayout = dev.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });
  const stampShaderModule = dev.createShaderModule({ code: stampShaderCode });
  const createPipeline = (blend: GPUBlendState) => dev.createRenderPipeline({
    layout: pipelineLayout,
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
          blend,
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
  const pipeline = createPipeline({
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
  });
  const eraserPipeline = createPipeline({
    color: {
      operation: "add",
      srcFactor: "zero",
      dstFactor: "one-minus-src-alpha",
    },
    alpha: {
      operation: "add",
      srcFactor: "zero",
      dstFactor: "one-minus-src-alpha",
    },
  });

  const bindGroup = dev.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: brushSampler },
      { binding: 1, resource: brushTextureView },
      { binding: 2, resource: { buffer: stampBuffer } },
      { binding: 3, resource: { buffer: stampUniformBuffer } },
    ],
  });

  return { pipeline, eraserPipeline, bindGroup };
}

export function createCompositePipelineResources(dev: GPUDevice): CompositePipelineResources {
  const bindGroupLayout = dev.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  });

  const shaderModule = dev.createShaderModule({ code: compositeShaderCode });
  const pipeline = dev.createRenderPipeline({
    layout: dev.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: {
      module: shaderModule,
      entryPoint: "vs",
    },
    fragment: {
      module: shaderModule,
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

  return { bindGroupLayout, pipeline };
}

export function createViewportPipelineResources(
  dev: GPUDevice,
  format: GPUTextureFormat,
  paintSampler: GPUSampler,
  compositeTextureView: GPUTextureView,
  viewUniformBuffer: GPUBuffer,
): ViewportPipelineResources {
  const bindGroupLayout = dev.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  });

  const pipeline = dev.createRenderPipeline({
    layout: dev.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
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

  const bindGroup = dev.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: paintSampler },
      { binding: 1, resource: compositeTextureView },
      { binding: 2, resource: { buffer: viewUniformBuffer } },
    ],
  });

  return { bindGroupLayout, pipeline, bindGroup };
}
