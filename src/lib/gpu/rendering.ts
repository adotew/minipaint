import { FLOATS_PER_STAMP } from "../core/constants";
import type { Rgba } from "../core/color";
import { getStampBounds } from "../core/geometry";
import type { ToolMode } from "../core/types";

export type Stamp = {
  x: number;
  y: number;
  radius: number;
  rgba: Rgba;
  mode: ToolMode;
  sourceX?: number;
  sourceY?: number;
};

export type StampTargetLayer = {
  texture: GPUTexture;
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
    stampDataView[offset + 8] = stamp.sourceX ?? minX;
    stampDataView[offset + 9] = stamp.sourceY ?? minY;
    stampDataView[offset + 10] = maxX;
    stampDataView[offset + 11] = maxY;
  }
}

function renderStampRun(options: {
  encoder: GPUCommandEncoder;
  activeLayer: StampTargetLayer;
  stampPipeline: GPURenderPipeline;
  eraserStampPipeline: GPURenderPipeline;
  stampBindGroup: GPUBindGroup;
  mode: ToolMode;
  runStart: number;
  runEnd: number;
}) {
  const pass = options.encoder.beginRenderPass({
    colorAttachments: [
      {
        view: options.activeLayer.view,
        loadOp: "load",
        storeOp: "store",
      },
    ],
  });
  pass.setBindGroup(0, options.stampBindGroup);
  pass.setPipeline(options.mode === "eraser" ? options.eraserStampPipeline : options.stampPipeline);
  pass.draw(6, options.runEnd - options.runStart, 0, options.runStart);
  pass.end();
}

function renderSmudgeStamp(options: {
  encoder: GPUCommandEncoder;
  activeLayer: StampTargetLayer;
  smudgePipeline: GPURenderPipeline;
  smudgeBindGroup: GPUBindGroup;
  smudgeSourceTexture: GPUTexture;
  stamp: Stamp;
  stampIndex: number;
  documentWidth: number;
  documentHeight: number;
}) {
  const pass = options.encoder.beginRenderPass({
    colorAttachments: [
      {
        view: options.activeLayer.view,
        loadOp: "load",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(options.smudgePipeline);
  pass.setBindGroup(0, options.smudgeBindGroup);
  pass.draw(6, 1, 0, options.stampIndex);
  pass.end();

  const bounds = getStampBounds(
    options.stamp.x,
    options.stamp.y,
    options.stamp.radius,
    options.documentWidth,
    options.documentHeight,
  );
  if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return;

  options.encoder.copyTextureToTexture(
    {
      texture: options.activeLayer.texture,
      origin: { x: bounds.minX, y: bounds.minY },
    },
    {
      texture: options.smudgeSourceTexture,
      origin: { x: bounds.minX, y: bounds.minY },
    },
    [bounds.width, bounds.height, 1],
  );
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
  eraserStampPipeline: GPURenderPipeline;
  smudgePipeline: GPURenderPipeline;
  stampBindGroup: GPUBindGroup;
  smudgeBindGroup: GPUBindGroup | null;
  smudgeSourceTexture: GPUTexture | null;
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

  let rendered = false;
  let runStart = 0;
  while (runStart < options.count) {
    const mode = options.stamps[runStart].mode;

    if (mode === "smudge") {
      if (options.smudgeBindGroup && options.smudgeSourceTexture) {
        renderSmudgeStamp({
          encoder: options.encoder,
          activeLayer,
          smudgePipeline: options.smudgePipeline,
          smudgeBindGroup: options.smudgeBindGroup,
          smudgeSourceTexture: options.smudgeSourceTexture,
          stamp: options.stamps[runStart],
          stampIndex: runStart,
          documentWidth: options.documentWidth,
          documentHeight: options.documentHeight,
        });
        rendered = true;
      }
      runStart++;
      continue;
    }

    let runEnd = runStart + 1;
    while (runEnd < options.count && options.stamps[runEnd].mode === mode) {
      runEnd++;
    }

    renderStampRun({
      encoder: options.encoder,
      activeLayer,
      stampPipeline: options.stampPipeline,
      eraserStampPipeline: options.eraserStampPipeline,
      stampBindGroup: options.stampBindGroup,
      mode,
      runStart,
      runEnd,
    });
    rendered = true;
    runStart = runEnd;
  }

  return rendered;
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
