export async function loadBrushStampBitmap(url: string) {
  const response = await fetch(url);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

export function createBrushStampTexture(dev: GPUDevice, bitmap: ImageBitmap) {
  const texture = dev.createTexture({
    size: [bitmap.width, bitmap.height],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  dev.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture },
    [bitmap.width, bitmap.height],
  );
  return texture;
}
