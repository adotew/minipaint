import { BYTES_PER_PIXEL } from "../core/constants";

export function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Failed to encode PNG."));
      }
    }, "image/png");
  });
}

export async function pixelsToPngBlob(pixels: Uint8ClampedArray, width: number, height: number) {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = width;
  exportCanvas.height = height;

  const ctx = exportCanvas.getContext("2d");
  if (!ctx) throw new Error("Could not create PNG export canvas.");

  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  return await canvasToPngBlob(exportCanvas);
}

export function unpremultiplyPixels(pixels: Uint8ClampedArray) {
  for (let i = 0; i < pixels.length; i += BYTES_PER_PIXEL) {
    const alpha = pixels[i + 3];
    if (alpha === 0) {
      pixels[i] = 0;
      pixels[i + 1] = 0;
      pixels[i + 2] = 0;
      continue;
    }

    pixels[i] = Math.min(255, Math.round(pixels[i] * 255 / alpha));
    pixels[i + 1] = Math.min(255, Math.round(pixels[i + 1] * 255 / alpha));
    pixels[i + 2] = Math.min(255, Math.round(pixels[i + 2] * 255 / alpha));
  }
}

export function premultiplyPixels(pixels: Uint8ClampedArray) {
  for (let i = 0; i < pixels.length; i += BYTES_PER_PIXEL) {
    const alpha = pixels[i + 3];
    pixels[i] = Math.round(pixels[i] * alpha / 255);
    pixels[i + 1] = Math.round(pixels[i + 1] * alpha / 255);
    pixels[i + 2] = Math.round(pixels[i + 2] * alpha / 255);
  }
}

export async function pngBlobToPixels(blob: Blob, width: number, height: number) {
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width !== width || bitmap.height !== height) {
      throw new Error(`Layer image has unsupported size ${bitmap.width} × ${bitmap.height}.`);
    }

    const decodeCanvas = document.createElement("canvas");
    decodeCanvas.width = width;
    decodeCanvas.height = height;
    const ctx = decodeCanvas.getContext("2d");
    if (!ctx) throw new Error("Could not create PNG decode canvas.");

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close?.();
  }
}

export function bytesToBlob(bytes: Uint8Array, type: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type });
}

export function blobToBytes(blob: Blob) {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}
