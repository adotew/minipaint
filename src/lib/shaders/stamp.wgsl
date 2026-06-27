@group(0) @binding(0) var paint: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<storage> brushes: array<Brush>;
@group(0) @binding(2) var brushStamp: texture_2d<f32>;

struct Brush {
  center: vec2f,
  radius: f32,
  pad1: f32,
  color: vec4f,
  bounds: vec4f,
};

@compute @workgroup_size(8, 8, 1)
fn stamp(@builtin(global_invocation_id) id: vec3u, @builtin(workgroup_id) wg: vec3u) {
  let stampIndex = wg.z;
  if (stampIndex >= arrayLength(&brushes)) { return; }

  let brush = brushes[stampIndex];

  let minX = u32(brush.bounds.x);
  let minY = u32(brush.bounds.y);
  let maxX = u32(brush.bounds.z);
  let maxY = u32(brush.bounds.w);

  let px = id.x + minX;
  let py = id.y + minY;

  if (px < minX || px > maxX || py < minY || py > maxY) { return; }

  let boundsSize = vec2f(brush.bounds.z - brush.bounds.x + 1.0, brush.bounds.w - brush.bounds.y + 1.0);
  let local = (vec2f(f32(px) + 0.5, f32(py) + 0.5) - brush.bounds.xy) / boundsSize;

  let stampSize = textureDimensions(brushStamp);
  let stampSizeF = vec2f(f32(stampSize.x), f32(stampSize.y));
  let stampMax = stampSize - vec2u(1, 1);
  let stampPos = min(vec2u(local * stampSizeF), stampMax);
  let mask = textureLoad(brushStamp, vec2i(i32(stampPos.x), i32(stampPos.y)), 0).a;

  if (mask > 0.05) {
    textureStore(paint, vec2i(i32(px), i32(py)), brush.color);
  }
}
