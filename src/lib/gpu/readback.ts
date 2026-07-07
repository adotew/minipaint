import { COPY_BYTES_PER_ROW_ALIGNMENT } from "../core/constants";

export async function readTexturePixel(
  dev: GPUDevice,
  texture: GPUTexture,
  buffer: GPUBuffer,
  x: number,
  y: number,
) {
  const encoder = dev.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture, origin: { x, y } },
    {
      buffer,
      bytesPerRow: COPY_BYTES_PER_ROW_ALIGNMENT,
      rowsPerImage: 1,
    },
    [1, 1, 1],
  );
  dev.queue.submit([encoder.finish()]);

  await buffer.mapAsync(GPUMapMode.READ);
  try {
    const mapped = buffer.getMappedRange();
    const pixels = new Uint8Array(mapped);
    return [pixels[0], pixels[1], pixels[2], pixels[3]] as const;
  } finally {
    buffer.unmap();
  }
}

export function premultipliedRgbaToHex(r: number, g: number, b: number, a: number) {
  const unpremultiply = (channel: number) =>
    a === 0 ? 255 : Math.min(255, Math.round(channel * 255 / a));

  return (
    "#" +
    [unpremultiply(r), unpremultiply(g), unpremultiply(b)]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")
  );
}
