import { BRUSH_STAMP_ASPECT, MIN_STAMP_SPACING, STAMP_SPACING_RATIO } from "./constants";

export function getStampHalfSize(radius: number) {
  if (BRUSH_STAMP_ASPECT >= 1) {
    return { halfWidth: radius, halfHeight: radius / BRUSH_STAMP_ASPECT };
  }

  return { halfWidth: radius * BRUSH_STAMP_ASPECT, halfHeight: radius };
}

export function getStampSpacing(radius: number) {
  return Math.max(MIN_STAMP_SPACING, radius * STAMP_SPACING_RATIO);
}

export function getStampBounds(x: number, y: number, radius: number, width: number, height: number) {
  const { halfWidth, halfHeight } = getStampHalfSize(radius);
  const minX = Math.max(0, Math.floor(x - halfWidth));
  const maxX = Math.min(width - 1, Math.ceil(x + halfWidth));
  const minY = Math.max(0, Math.floor(y - halfHeight));
  const maxY = Math.min(height - 1, Math.ceil(y + halfHeight));

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    halfWidth,
    halfHeight,
  };
}
