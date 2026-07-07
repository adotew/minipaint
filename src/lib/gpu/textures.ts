import { BYTES_PER_PIXEL, COPY_BYTES_PER_ROW_ALIGNMENT } from "../core/constants";
import { alignTo } from "../core/math";

export function createDocumentTexture(dev: GPUDevice, width: number, height: number, label: string) {
  return dev.createTexture({
    label,
    size: [width, height],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST,
  });
}

export function clearTexture(dev: GPUDevice, tex: GPUTexture, colorValue: GPUColor) {
  const encoder = dev.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: tex.createView(),
        loadOp: "clear",
        clearValue: colorValue,
        storeOp: "store",
      },
    ],
  });
  pass.end();
  dev.queue.submit([encoder.finish()]);
}

export function copyTexture(dev: GPUDevice, source: GPUTexture, width: number, height: number, label: string) {
  const snapshot = createDocumentTexture(dev, width, height, label);
  const encoder = dev.createCommandEncoder();
  encoder.copyTextureToTexture(
    { texture: source },
    { texture: snapshot },
    [width, height],
  );
  dev.queue.submit([encoder.finish()]);
  return snapshot;
}

export function restoreTexture(dev: GPUDevice, target: GPUTexture, snapshot: GPUTexture, width: number, height: number) {
  const encoder = dev.createCommandEncoder();
  encoder.copyTextureToTexture(
    { texture: snapshot },
    { texture: target },
    [width, height],
  );
  dev.queue.submit([encoder.finish()]);
}

export async function readTexturePixels(dev: GPUDevice, texture: GPUTexture, width: number, height: number) {
  const bytesPerRow = width * BYTES_PER_PIXEL;
  const paddedBytesPerRow = alignTo(bytesPerRow, COPY_BYTES_PER_ROW_ALIGNMENT);
  const bufferSize = paddedBytesPerRow * height;
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
      rowsPerImage: height,
    },
    [width, height, 1],
  );
  dev.queue.submit([encoder.finish()]);

  let isMapped = false;
  try {
    await readBuffer.mapAsync(GPUMapMode.READ);
    isMapped = true;

    const mapped = readBuffer.getMappedRange();
    const source = new Uint8Array(mapped);
    const pixels = new Uint8ClampedArray(width * height * BYTES_PER_PIXEL);

    for (let y = 0; y < height; y++) {
      const sourceOffset = y * paddedBytesPerRow;
      const targetOffset = y * bytesPerRow;
      pixels.set(source.subarray(sourceOffset, sourceOffset + bytesPerRow), targetOffset);
    }

    return pixels;
  } finally {
    if (isMapped) readBuffer.unmap();
    readBuffer.destroy();
  }
}

export function uploadTexturePixels(
  dev: GPUDevice,
  texture: GPUTexture,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const bytesPerRow = width * BYTES_PER_PIXEL;
  const paddedBytesPerRow = alignTo(bytesPerRow, COPY_BYTES_PER_ROW_ALIGNMENT);
  const padded = new Uint8Array(paddedBytesPerRow * height);

  for (let y = 0; y < height; y++) {
    const sourceOffset = y * bytesPerRow;
    const targetOffset = y * paddedBytesPerRow;
    padded.set(pixels.subarray(sourceOffset, sourceOffset + bytesPerRow), targetOffset);
  }

  dev.queue.writeTexture(
    { texture },
    padded,
    {
      bytesPerRow: paddedBytesPerRow,
      rowsPerImage: height,
    },
    [width, height, 1],
  );
}
