@group(0) @binding(0) var paint: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<storage> brushes: array<Brush>;

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

  let p = vec2f(f32(px) + 0.5, f32(py) + 0.5);
  if (distance(p, brush.center) <= brush.radius) {
    textureStore(paint, vec2i(i32(px), i32(py)), brush.color);
  }
}
