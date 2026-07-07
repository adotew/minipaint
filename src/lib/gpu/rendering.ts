import { FLOATS_PER_STAMP } from "../core/constants";
import type { Rgba } from "../core/color";
import { getStampBounds } from "../core/geometry";

export type Stamp = {
  x: number;
  y: number;
  radius: number;
  rgba: Rgba;
};

export type StampTargetLayer = {
  view: GPUTextureView;
  visible: boolean;
  locked: boolean;
};

export type CompositeLayer = {
  visible: boolean;
  compositeBindGroup: GPUBindGroup;
};

export type ViewUniformState = {
  cssWidth: number;
  cssHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
  documentWidth: number;
  documentHeight: number;
};

export function writeViewUniforms(dev: GPUDevice, buffer: GPUBuffer, state: ViewUniformState) {
  const viewUniforms = new Float32Array([
    state.cssWidth / (state.canvasWidth * state.zoom),
    state.cssHeight / (state.canvasHeight * state.zoom),
    state.offsetX,
    state.offsetY,
    state.documentWidth,
    state.documentHeight,
    0,
    0,
  ]);
  dev.queue.writeBuffer(buffer, 0, viewUniforms);
}

export function writeStampData(
  stampDataView: Float32Array,
  stamps: Stamp[],
  count: number,
  documentWidth: number,
  documentHeight: number,
) {
  for (let i = 0; i < count; i++) {
    const stamp = stamps[i];
    const { minX, maxX, minY, maxY, halfWidth, halfHeight } = getStampBounds(
      stamp.x,
      stamp.y,
      stamp.radius,
      documentWidth,
      documentHeight,
    );

    const offset = i * FLOATS_PER_STAMP;
    stampDataView[offset + 0] = stamp.x;
    stampDataView[offset + 1] = stamp.y;
    stampDataView[offset + 2] = halfWidth;
    stampDataView[offset + 3] = halfHeight;
    stampDataView[offset + 4] = stamp.rgba[0];
    stampDataView[offset + 5] = stamp.rgba[1];
    stampDataView[offset + 6] = stamp.rgba[2];
    stampDataView[offset + 7] = stamp.rgba[3];
    stampDataView[offset + 8] = minX;
    stampDataView[offset + 9] = minY;
    stampDataView[offset + 10] = maxX;
    stampDataView[offset + 11] = maxY;
  }
}

export function renderStamps(options: {
  encoder: GPUCommandEncoder;
  device: GPUDevice;
  stampBuffer: GPUBuffer;
  stampDataView: Float32Array;
  stamps: Stamp[];
  count: number;
  documentWidth: number;
  documentHeight: number;
  activeLayer: StampTargetLayer | null;
  stampPipeline: GPURenderPipeline;
  stampBindGroup: GPUBindGroup;
}) {
  const activeLayer = options.activeLayer;
  if (!activeLayer || !activeLayer.visible || activeLayer.locked) return false;

  writeStampData(
    options.stampDataView,
    options.stamps,
    options.count,
    options.documentWidth,
    options.documentHeight,
  );
  options.device.queue.writeBuffer(
    options.stampBuffer,
    0,
    options.stampDataView,
    0,
    options.count * FLOATS_PER_STAMP,
  );

  const pass = options.encoder.beginRenderPass({
    colorAttachments: [
      {
        view: activeLayer.view,
        loadOp: "load",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(options.stampPipeline);
  pass.setBindGroup(0, options.stampBindGroup);
  pass.draw(6, options.count);
  pass.end();
  return true;
}

export function rebuildComposite(
  encoder: GPUCommandEncoder,
  compositeTextureView: GPUTextureView,
  compositePipeline: GPURenderPipeline,
  layers: CompositeLayer[],
) {
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: compositeTextureView,
        loadOp: "clear",
        clearValue: [1, 1, 1, 1],
        storeOp: "store",
      },
    ],
  });

  pass.setPipeline(compositePipeline);
  for (const layer of layers) {
    if (!layer.visible) continue;
    pass.setBindGroup(0, layer.compositeBindGroup);
    pass.draw(3);
  }
  pass.end();
}

export function blitCompositeToViewport(
  encoder: GPUCommandEncoder,
  context: GPUCanvasContext,
  renderPipeline: GPURenderPipeline,
  renderBindGroup: GPUBindGroup,
) {
  const textureView = context.getCurrentTexture().createView();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: textureView,
        loadOp: "clear",
        clearValue: [0.5, 0.5, 0.5, 1],
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(renderPipeline);
  pass.setBindGroup(0, renderBindGroup);
  pass.draw(3);
  pass.end();
}
