// Material helpers shared by prop kinds. Requires propCommonWgsl.

fn triplanarDetail(p: vec3f, n: vec3f, scale: f32) -> vec4f {
  var w = pow(abs(n), vec3f(4.0));
  w /= (w.x + w.y + w.z);
  return textureSample(tDetail, sLinearRepeat, p.zy * scale) * w.x +
    textureSample(tDetail, sLinearRepeat, p.xz * scale) * w.y +
    textureSample(tDetail, sLinearRepeat, p.xy * scale) * w.z;
}

/** Perturbs a normal by a 3D noise-like vector, keeping it on the hemisphere. */
fn bumpNormal(n: vec3f, pert: vec3f) -> vec3f {
  return normalize(n + pert - n * dot(pert, n));
}

fn hash11(x: f32) -> f32 {
  return fract(sin(x * 127.1) * 43758.5453);
}

/** Palette lookup (Inigo Quilez cosine palettes). */
fn palette(t: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f {
  return a + b * cos(6.2831853 * (c * t + d));
}

/** Gentle sway from the water current: displacement grows with height^2. */
fn currentSway(worldBase: vec3f, height: f32, t: f32, strength: f32, phase: f32) -> vec3f {
  let dir = normalize(vec3f(1.0, 0.0, 0.35));
  let s1 = sin(t * 0.9 + phase + dot(worldBase.xz, vec2f(0.21, 0.13)));
  let s2 = sin(t * 1.7 + phase * 1.3 + dot(worldBase.xz, vec2f(-0.11, 0.27)));
  let side = vec3f(-dir.z, 0.0, dir.x);
  let h2 = height * height;
  return (dir * (s1 * 0.8 + 0.35) + side * s2 * 0.45) * h2 * strength;
}
