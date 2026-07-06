# Brush Pressure Opacity

## Goal

Stylus pressure should affect brush opacity as well as brush size, similar to apps like Procreate and Photoshop.

Expected behavior:

- Light pen pressure creates smaller, more transparent marks.
- Heavy pen pressure creates larger, more opaque marks.
- Repeated light strokes build opacity naturally.
- Mouse input stays fully opaque.

## Implementation approach

The previous brush shader used a compute pass that overwrote pixels directly. That approach cannot produce natural opacity buildup because alpha values would replace pixels instead of compositing over existing paint.

The implemented approach uses render-pipeline stamping:

1. Each brush stamp is stored in a GPU storage buffer.
2. A render pipeline draws one textured quad per stamp using instancing.
3. The brush stamp texture alpha is multiplied by pressure-derived opacity.
4. WebGPU fixed-function alpha blending composites the stamp into the full-resolution paint texture.
5. The existing blit render pipeline presents the paint texture to the visible canvas.

Blend mode:

```ts
blend: {
  color: {
    operation: "add",
    srcFactor: "src-alpha",
    dstFactor: "one-minus-src-alpha",
  },
  alpha: {
    operation: "add",
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
  },
}
```

## Pressure opacity curve

The opacity mapping uses a gamma curve:

```ts
const MIN_PRESSURE_OPACITY = 0.08;
const PRESSURE_OPACITY_GAMMA = 1.35;

opacity = MIN_PRESSURE_OPACITY +
  (1 - MIN_PRESSURE_OPACITY) * Math.pow(pressure, PRESSURE_OPACITY_GAMMA);
```

This keeps very light marks visible while making low pressure more delicate than a linear curve.

## Stamp spacing

Alpha blending makes over-stamping visible, so the stroke path now uses distance-based stamp spacing instead of re-emitting the previous point for every pointer event.

Constants:

```ts
const STAMP_SPACING_RATIO = 0.25;
const MIN_STAMP_SPACING = 1;
```

This reduces dark blobs at pointer event boundaries while keeping strokes continuous.

## Files changed

- `src/lib/WebGPUCanvas.svelte`
- `src/lib/shaders/stamp.wgsl`

## Testing checklist

- Mouse drawing remains opaque.
- Light pen pressure creates faint marks.
- Heavy pen pressure creates strong marks.
- Pressure changes during a stroke affect size and opacity smoothly.
- Slow strokes do not create dark knots at pointer event boundaries.
- Fast strokes stay continuous.
- Repeated light passes build opacity.
- Undo/redo works.
- PNG export matches the canvas.
