import type { Rgba } from "../core/color";
import { withAlpha } from "../core/color";
import { getStampBounds, getStampSpacing } from "../core/geometry";
import { lerp } from "../core/math";
import type { Stamp } from "../gpu/rendering";

export class StampQueue {
  pending: Stamp[] = [];
  distanceSinceLastStamp = 0;

  get length() {
    return this.pending.length;
  }

  clear() {
    this.pending = [];
    this.distanceSinceLastStamp = 0;
  }

  takeAll() {
    const stamps = this.pending;
    this.pending = [];
    return stamps;
  }

  prepend(stamps: Stamp[]) {
    this.pending = stamps.concat(this.pending);
  }

  queueStamp(
    x: number,
    y: number,
    radius: number,
    rgba: Rgba,
    documentWidth: number,
    documentHeight: number,
  ) {
    const { minX, maxX, minY, maxY, halfWidth, halfHeight } = getStampBounds(
      x,
      y,
      radius,
      documentWidth,
      documentHeight,
    );

    if (
      x + halfWidth < 0 ||
      y + halfHeight < 0 ||
      x - halfWidth >= documentWidth ||
      y - halfHeight >= documentHeight ||
      maxX < minX ||
      maxY < minY
    ) {
      return false;
    }

    this.pending.push({ x, y, radius, rgba });
    return true;
  }

  stampLine(options: {
    x1: number;
    y1: number;
    r1: number;
    o1: number;
    x2: number;
    y2: number;
    r2: number;
    o2: number;
    rgba: Rgba;
    documentWidth: number;
    documentHeight: number;
  }) {
    const dx = options.x2 - options.x1;
    const dy = options.y2 - options.y1;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return 0;

    let queued = 0;
    let travelled = 0;
    while (travelled < dist) {
      const spacingT = travelled / dist;
      const spacingRadius = lerp(options.r1, options.r2, spacingT);
      const spacing = getStampSpacing(spacingRadius);
      const distanceToNextStamp = Math.max(0, spacing - this.distanceSinceLastStamp);
      const remainingDistance = dist - travelled;

      if (distanceToNextStamp > remainingDistance) {
        this.distanceSinceLastStamp += remainingDistance;
        return queued;
      }

      travelled += distanceToNextStamp;
      const t = travelled / dist;
      const radius = lerp(options.r1, options.r2, t);
      const opacity = lerp(options.o1, options.o2, t);
      if (this.queueStamp(
        options.x1 + dx * t,
        options.y1 + dy * t,
        radius,
        withAlpha(options.rgba, opacity),
        options.documentWidth,
        options.documentHeight,
      )) {
        queued++;
      }
      this.distanceSinceLastStamp = 0;
    }

    return queued;
  }
}
