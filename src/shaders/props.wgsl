// Material helpers shared by prop kinds. Requires propCommonWgsl.

fn triplanarDetail(p: vec3f, n: vec3f, scale: f32) -> vec4f {
  var w = pow(abs(n), vec3f(4.0));
  w /= (w.x + w.y + w.z);
  return textureSample(tDetail, sLinearRepeat, p.zy * scale) * w.x +
    textureSample(tDetail, sLinearRepeat, p.xz * scale) * w.y +
    textureSample(tDetail, sLinearRepeat, p.xy * scale) * w.z;
}

/**
 * Detail texture lookup with a quality level, usable inside branches (explicit
 * mip level from a precomputed world-space pixel footprint `fw`):
 * level 2 = full triplanar (3 samples), 1 = dominant axis only (1 sample),
 * 0 = skipped (mid-grey). Distant surfaces drop to cheaper levels.
 */
fn detailSample(p: vec3f, n: vec3f, scale: f32, fw: f32, level: u32) -> vec4f {
  if (level == 0u) {
    return vec4f(0.5);
  }
  let lod = log2(max(fw * scale * 512.0, 1.0));
  let a = abs(n);
  if (level == 1u) {
    if (a.y >= a.x && a.y >= a.z) {
      return textureSampleLevel(tDetail, sLinearRepeat, p.xz * scale, lod);
    }
    if (a.x >= a.z) {
      return textureSampleLevel(tDetail, sLinearRepeat, p.zy * scale, lod);
    }
    return textureSampleLevel(tDetail, sLinearRepeat, p.xy * scale, lod);
  }
  var w = pow(a, vec3f(4.0));
  w /= (w.x + w.y + w.z);
  return textureSampleLevel(tDetail, sLinearRepeat, p.zy * scale, lod) * w.x +
    textureSampleLevel(tDetail, sLinearRepeat, p.xz * scale, lod) * w.y +
    textureSampleLevel(tDetail, sLinearRepeat, p.xy * scale, lod) * w.z;
}

/** Perturbs a normal by a 3D noise-like vector, keeping it on the hemisphere. */
fn bumpNormal(n: vec3f, pert: vec3f) -> vec3f {
  return normalize(n + pert - n * dot(pert, n));
}

/**
 * Bump mapping from a scalar height using screen-space derivatives
 * (Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU"). Works on
 * any generated surface without tangents. Must be called in uniform control flow.
 */
fn bumpFromHeight(n: vec3f, pos: vec3f, height: f32, strength: f32) -> vec3f {
  let sx = dpdxFine(pos);
  let sy = dpdyFine(pos);
  let hx = dpdxFine(height) * strength;
  let hy = dpdyFine(height) * strength;
  let r1 = cross(sy, n);
  let r2 = cross(n, sx);
  let det = dot(sx, r1);
  let grad = sign(det) * (hx * r1 + hy * r2);
  return normalize(abs(det) * n - grad);
}

fn hash11(x: f32) -> f32 {
  return fract(sin(x * 127.1) * 43758.5453);
}

/** Palette lookup (Inigo Quilez cosine palettes). */
fn palette(t: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f {
  return a + b * cos(6.2831853 * (c * t + d));
}

/** Gentle sway from the water current: displacement grows with height^2. */
/**
 * Back-and-forth surge from the swell passing overhead: one slow (~7 s) wave
 * that rolls across the whole seabed, so everything soft leans together in a
 * visible travelling band rather than jiggling independently.
 */
fn surge(worldBase: vec3f, t: f32) -> f32 {
  let k = dot(worldBase.xz, normalize(vec2f(1.0, 0.35))) * 0.11;
  let s = sin(t * 0.9 - k);
  // Sharper push, slower return, like real surge.
  return s + 0.25 * sin(2.0 * (t * 0.9 - k) + 0.6);
}

fn currentSway(worldBase: vec3f, height: f32, t: f32, strength: f32, phase: f32) -> vec3f {
  let dir = normalize(vec3f(1.0, 0.0, 0.35));
  let s1 = sin(t * 1.3 + phase + dot(worldBase.xz, vec2f(0.21, 0.13)));
  let s2 = sin(t * 2.1 + phase * 1.3 + dot(worldBase.xz, vec2f(-0.11, 0.27)));
  let side = vec3f(-dir.z, 0.0, dir.x);
  let h2 = height * height;
  return (dir * (surge(worldBase, t) * 1.1 + s1 * 0.35 + 0.3) + side * s2 * 0.4) * h2 * strength;
}
