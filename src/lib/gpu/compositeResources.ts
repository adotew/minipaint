import { createDocumentTexture } from "./textures";

export type CompositeTextureResources = {
  texture: GPUTexture;
  view: GPUTextureView;
  renderBindGroup: GPUBindGroup;
};

export function createCompositeTextureResources(options: {
  device: GPUDevice;
  width: number;
  height: number;
  renderBindGroupLayout: GPUBindGroupLayout;
  paintSampler: GPUSampler;
  viewUniformBuffer: GPUBuffer;
}): CompositeTextureResources {
  const texture = createDocumentTexture(options.device, options.width, options.height, "Composite texture");
  const view = texture.createView();
  const renderBindGroup = options.device.createBindGroup({
    layout: options.renderBindGroupLayout,
    entries: [
      { binding: 0, resource: options.paintSampler },
      { binding: 1, resource: view },
      { binding: 2, resource: { buffer: options.viewUniformBuffer } },
    ],
  });

  return { texture, view, renderBindGroup };
}
