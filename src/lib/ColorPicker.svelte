<script lang="ts">
  interface Props {
    color: string;
    onchange: (color: string) => void;
  }
  let { color, onchange }: Props = $props();

  // Internal HSV state
  let h = $state(0);
  let s = $state(0);
  let v = $state(1);

  let svEl: HTMLDivElement;
  let hueEl: HTMLDivElement;

  function parseHex(hex: string) {
    const clean = hex.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(clean)) {
      return {
        r: parseInt(clean[0] + clean[0], 16),
        g: parseInt(clean[1] + clean[1], 16),
        b: parseInt(clean[2] + clean[2], 16),
      };
    }
    if (/^[0-9a-fA-F]{6}$/.test(clean)) {
      const n = parseInt(clean, 16);
      return {
        r: (n >> 16) & 255,
        g: (n >> 8) & 255,
        b: n & 255,
      };
    }
    return null;
  }

  function rgbToHsv(r: number, g: number, b: number) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let hue = 0;
    if (d !== 0) {
      if (max === r) hue = ((g - b) / d + 6) % 6;
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
    }
    return { h: hue, s: max === 0 ? 0 : d / max, v: max };
  }

  function hsvToHex(hue: number, sat: number, val: number) {
    const c = val * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = val - c;
    let r = 0,
      g = 0,
      b = 0;
    const i = Math.floor(hue / 60) % 6;
    switch (i) {
      case 0:
        r = c;
        g = x;
        b = 0;
        break;
      case 1:
        r = x;
        g = c;
        b = 0;
        break;
      case 2:
        r = 0;
        g = c;
        b = x;
        break;
      case 3:
        r = 0;
        g = x;
        b = c;
        break;
      case 4:
        r = x;
        g = 0;
        b = c;
        break;
      case 5:
        r = c;
        g = 0;
        b = x;
        break;
    }
    return (
      "#" +
      [r, g, b]
        .map((n) =>
          Math.round((n + m) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  }

  // Sync incoming hex prop to HSV state only when it changed externally.
  // If the prop matches what this picker would emit, skip it to avoid
  // round-trip floating-point drift that makes the hue slider jitter.
  $effect(() => {
    if (color === hsvToHex(h, s, v)) return;
    const rgb = parseHex(color);
    if (!rgb) return;
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    h = hsv.h;
    s = hsv.s;
    v = hsv.v;
  });

  function emit() {
    onchange(hsvToHex(h, s, v));
  }

  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
  }

  function updateSv(e: PointerEvent) {
    const rect = svEl.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const y = clamp(e.clientY - rect.top, 0, rect.height);
    s = x / rect.width;
    v = 1 - y / rect.height;
    emit();
  }

  function updateHue(e: PointerEvent) {
    const rect = hueEl.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    h = (x / rect.width) * 360;
    emit();
  }

  function onSvPointerDown(e: PointerEvent) {
    e.preventDefault();
    svEl.setPointerCapture(e.pointerId);
    updateSv(e);
  }

  function onSvPointerMove(e: PointerEvent) {
    if (!svEl.hasPointerCapture(e.pointerId)) return;
    updateSv(e);
  }

  function onSvPointerUp(e: PointerEvent) {
    svEl.releasePointerCapture(e.pointerId);
  }

  function onHuePointerDown(e: PointerEvent) {
    e.preventDefault();
    hueEl.setPointerCapture(e.pointerId);
    updateHue(e);
  }

  function onHuePointerMove(e: PointerEvent) {
    if (!hueEl.hasPointerCapture(e.pointerId)) return;
    updateHue(e);
  }

  function onHuePointerUp(e: PointerEvent) {
    hueEl.releasePointerCapture(e.pointerId);
  }

</script>

<div class="flex w-[200px] flex-col gap-3">
  <!-- Saturation / Value area -->
  <div
    role="button"
    tabindex="-1"
    aria-label="Color saturation and brightness picker"
    bind:this={svEl}
    class="relative aspect-square w-full cursor-crosshair rounded-md"
    style="background:
      linear-gradient(to bottom, transparent, #000),
      linear-gradient(to right, #fff, hsl({h}, 100%, 50%));"
    onpointerdown={onSvPointerDown}
    onpointermove={onSvPointerMove}
    onpointerup={onSvPointerUp}
  >
    <div
      class="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
      style="left: {s * 100}%; top: {(1 - v) * 100}%; background-color: {color};"
    ></div>
  </div>

  <!-- Hue slider -->
  <div
    role="slider"
    tabindex="-1"
    aria-label="Hue"
    aria-valuenow={Math.round(h)}
    aria-valuemin="0"
    aria-valuemax="360"
    bind:this={hueEl}
    class="relative h-4 w-full cursor-pointer rounded-md"
    style="background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);"
    onpointerdown={onHuePointerDown}
    onpointermove={onHuePointerMove}
    onpointerup={onHuePointerUp}
  >
    <div
      class="pointer-events-none absolute top-0 h-full w-2 -translate-x-1/2 rounded-sm border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
      style="left: {(h / 360) * 100}%; background-color: hsl({h}, 100%, 50%);"
    ></div>
  </div>

</div>
