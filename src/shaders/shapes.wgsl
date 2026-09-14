// Surface-function helpers for the GPU mesh builder. Requires PATCH_WGSL,
// noise, and the builder's `aux` storage buffer.

const TAU = 6.2831853;

/** Any unit vector perpendicular to `t`. */
fn perpendicular(t: vec3f) -> vec3f {
  let refV = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(t.y) > 0.9);
  return normalize(cross(t, refV));
}

fn catmullRom(p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f, t: f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return 0.5 * (2.0 * p1 + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
    (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
}

/** Point (xyz) and radius (w) along a chain of `count` aux points starting at `offset`. */
fn chainAt(offset: u32, count: u32, t: f32) -> vec4f {
  let f = clamp(t, 0.0, 1.0) * f32(count - 1u);
  let i = min(u32(floor(f)), count - 2u);
  let k = f - f32(i);
  let a = aux[offset + max(i, 1u) - 1u];
  let b = aux[offset + i];
  let c = aux[offset + i + 1u];
  let d = aux[offset + min(i + 2u, count - 1u)];
  // Extrapolate the end control points so the tube doesn't pinch.
  let a2 = select(a, 2.0 * b - c, i == 0u);
  let d2 = select(d, 2.0 * c - b, i + 2u >= count);
  return catmullRom(a2, b, c, d2, k);
}

/**
 * Tube along an aux chain. u goes around, v along. `tipTaper` rounds the end
 * closed. Returns the point and the tube's local frame for texturing.
 */
fn chainTube(offset: u32, count: u32, uv: vec2f, tipTaper: f32) -> SurfacePoint {
  let c = chainAt(offset, count, uv.y);
  let ahead = chainAt(offset, count, min(uv.y + 0.01, 1.0));
  let behind = chainAt(offset, count, max(uv.y - 0.01, 0.0));
  let t = normalize(ahead.xyz - behind.xyz + vec3f(0.0, 1e-5, 0.0));
  let side = perpendicular(t);
  let up = cross(side, t);
  let a = uv.x * TAU;
  var r = c.w;
  // Round the tip closed over the last few percent.
  let tip = smoothstep(1.0 - tipTaper, 1.0, uv.y);
  r *= sqrt(max(1.0 - tip * tip, 0.0));
  let radial = side * cos(a) + up * sin(a);
  var o = sp(c.xyz + radial * r, vec4f(uv, uv.y, 0.0));
  o.normal = normalize(radial * (1.0 - tip) + t * tip);
  return o;
}

/** Surface of revolution around +Y: profile gives (radius, height) for v in 0..1. */
fn lathePoint(radius: f32, height: f32, u: f32) -> vec3f {
  let a = u * TAU;
  return vec3f(cos(a) * radius, height, -sin(a) * radius);
}
