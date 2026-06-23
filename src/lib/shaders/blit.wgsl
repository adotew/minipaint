@group(0) @binding(0) var paintSampler: sampler;
@group(0) @binding(1) var paintTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> view: View;

struct View {
  scale: vec2f,
  offset: vec2f,
  paintDims: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
  let x = f32(idx % 2u) * 4.0 - 1.0;
  let y = f32(idx / 2u) * 4.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let paintCoord = pos.xy * view.scale + view.offset;
  let uv = paintCoord / view.paintDims;
  // Clamp UVs to prevent texture bleeding when panned outside paint area
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  return textureSample(paintTex, paintSampler, clampedUV);
}
