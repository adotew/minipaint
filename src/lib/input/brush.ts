import {
  MIN_PRESSURE_OPACITY,
  MIN_PRESSURE_SIZE,
  PRESSURE_EPSILON,
  PRESSURE_FALLBACK,
  PRESSURE_OPACITY_GAMMA,
} from "../core/constants";
import { clamp } from "../core/math";

export function getMinimumPressureRadius(brushSize: number) {
  return brushSize * MIN_PRESSURE_SIZE / 2;
}

export function getMinimumPressureOpacity() {
  return MIN_PRESSURE_OPACITY;
}

export function hasRealPressure(e: PointerEvent): boolean {
  const p = typeof e.pressure === "number" ? e.pressure : 0;
  return e.pointerType === "pen" || (p > 0 && Math.abs(p - PRESSURE_FALLBACK) > PRESSURE_EPSILON);
}

export function getBrushRadius(
  e: PointerEvent,
  brushSize: number,
  usesPressure: boolean,
  fallbackRadius: number,
) {
  if (!usesPressure) {
    return brushSize / 2;
  }

  const p = typeof e.pressure === "number" ? e.pressure : 0;
  if (p > 0) {
    const pressureScale = MIN_PRESSURE_SIZE + (1 - MIN_PRESSURE_SIZE) * clamp(p, 0, 1);
    return brushSize * pressureScale / 2;
  }

  return fallbackRadius;
}

export function getBrushOpacity(e: PointerEvent, usesPressure: boolean, fallbackOpacity: number) {
  if (!usesPressure) return 1;

  const p = typeof e.pressure === "number" ? e.pressure : 0;
  if (p > 0) {
    const pressure = clamp(p, 0, 1);
    return MIN_PRESSURE_OPACITY +
      (1 - MIN_PRESSURE_OPACITY) * Math.pow(pressure, PRESSURE_OPACITY_GAMMA);
  }

  return fallbackOpacity;
}

export function getBrushPreviewRadius(options: {
  e: PointerEvent;
  isDrawing: boolean;
  usesPressure: boolean;
  brushSize: number;
  fallbackRadius: number;
}) {
  if (!options.isDrawing) {
    return getMinimumPressureRadius(options.brushSize);
  }

  if (options.usesPressure) {
    return getBrushRadius(options.e, options.brushSize, true, options.fallbackRadius);
  }

  return options.brushSize / 2;
}

export function resizeBrushSize(startBrushSize: number, startY: number, currentY: number) {
  return Math.round(clamp(startBrushSize - (currentY - startY), 1, 500));
}
