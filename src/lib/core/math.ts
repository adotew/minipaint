export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function alignTo(n: number, alignment: number) {
  return Math.ceil(n / alignment) * alignment;
}
