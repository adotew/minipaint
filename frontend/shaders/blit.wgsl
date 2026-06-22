@group(0) @binding(0) var paintSampler: sampler;
@group(0) @binding(1) var paintTex: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
  let x = f32(idx % 2u) * 4.0 - 1.0;
  let y = f32(idx / 2u) * 4.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(paintTex));
  let uv = pos.xy / dims;
  return textureSample(paintTex, paintSampler, uv);
}
