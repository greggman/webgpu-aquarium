// Hashing and procedural noise. `noiseSeed` perturbs every hash so each run
// generates different content; set it at the top of an entry point.

var<private> noiseSeed: u32 = 0u;

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn pcg3d(vIn: vec3u) -> vec3u {
  var v = vIn * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

fn hash2i(p: vec2i) -> u32 {
  return pcg(bitcast<u32>(p.x) + pcg(bitcast<u32>(p.y) + pcg(noiseSeed)));
}

fn hash3i(p: vec3i) -> vec3u {
  return pcg3d(bitcast<vec3u>(p) + vec3u(noiseSeed * 3u, noiseSeed * 7u, noiseSeed * 13u));
}

fn rand01(h: u32) -> f32 {
  return f32(h >> 8u) / 16777216.0;
}

fn hashTo2(h: u32) -> vec2f {
  return vec2f(rand01(h), rand01(pcg(h)));
}

fn gradient2(cell: vec2i) -> vec2f {
  let a = rand01(hash2i(cell)) * 6.2831853;
  return vec2f(cos(a), sin(a));
}

fn wrapCell(c: vec2i, period: vec2i) -> vec2i {
  if (period.x <= 0) {
    return c;
  }
  return ((c % period) + period) % period;
}

/** 2D gradient noise in [-1, 1]. Tiles when period > 0 (in cells). */
fn gradNoise2p(p: vec2f, period: vec2i) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let g00 = dot(gradient2(wrapCell(i, period)), f);
  let g10 = dot(gradient2(wrapCell(i + vec2i(1, 0), period)), f - vec2f(1.0, 0.0));
  let g01 = dot(gradient2(wrapCell(i + vec2i(0, 1), period)), f - vec2f(0.0, 1.0));
  let g11 = dot(gradient2(wrapCell(i + vec2i(1, 1), period)), f - vec2f(1.0, 1.0));
  return 1.414 * mix(mix(g00, g10, u.x), mix(g01, g11, u.x), u.y);
}

fn gradNoise2(p: vec2f) -> f32 {
  return gradNoise2p(p, vec2i(0));
}

fn gradient3(cell: vec3i) -> vec3f {
  let h = hash3i(cell);
  return normalize(vec3f(h) / 4294967295.0 * 2.0 - 1.0 + vec3f(1e-4));
}

/** 3D gradient noise in about [-1, 1]. */
fn gradNoise3(p: vec3f) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let n000 = dot(gradient3(i), f);
  let n100 = dot(gradient3(i + vec3i(1, 0, 0)), f - vec3f(1, 0, 0));
  let n010 = dot(gradient3(i + vec3i(0, 1, 0)), f - vec3f(0, 1, 0));
  let n110 = dot(gradient3(i + vec3i(1, 1, 0)), f - vec3f(1, 1, 0));
  let n001 = dot(gradient3(i + vec3i(0, 0, 1)), f - vec3f(0, 0, 1));
  let n101 = dot(gradient3(i + vec3i(1, 0, 1)), f - vec3f(1, 0, 1));
  let n011 = dot(gradient3(i + vec3i(0, 1, 1)), f - vec3f(0, 1, 1));
  let n111 = dot(gradient3(i + vec3i(1, 1, 1)), f - vec3f(1, 1, 1));
  return 1.3 * mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z,
  );
}

fn fbm2(pIn: vec2f, octaves: i32) -> f32 {
  var p = pIn;
  var sum = 0.0;
  var amp = 0.5;
  for (var i = 0; i < octaves; i++) {
    sum += amp * gradNoise2(p);
    p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p + vec2f(17.3, 9.1);
    amp *= 0.5;
  }
  return sum;
}

/** Tileable fbm: period in cells at the base octave; doubles each octave. */
fn fbm2p(p: vec2f, octaves: i32, period: i32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  var per = period;
  for (var i = 0; i < octaves; i++) {
    sum += amp * gradNoise2p(p * freq + f32(i) * 13.0 * f32(per), vec2i(per));
    freq *= 2.0;
    per *= 2;
    amp *= 0.5;
  }
  return sum;
}

fn ridged2(pIn: vec2f, octaves: i32) -> f32 {
  var p = pIn;
  var sum = 0.0;
  var amp = 0.5;
  var prev = 1.0;
  for (var i = 0; i < octaves; i++) {
    var n = 1.0 - abs(gradNoise2(p));
    n = n * n;
    sum += n * amp * prev;
    prev = n;
    p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p + vec2f(5.7, 21.3);
    amp *= 0.5;
  }
  return sum;
}

fn fbm3(pIn: vec3f, octaves: i32) -> f32 {
  var p = pIn;
  var sum = 0.0;
  var amp = 0.5;
  for (var i = 0; i < octaves; i++) {
    sum += amp * gradNoise3(p);
    p = p * 2.03 + vec3f(11.1, 3.7, 7.9);
    amp *= 0.5;
  }
  return sum;
}

/** Worley noise: returns (F1, F2) distances. Tiles when period > 0. */
fn worley2p(p: vec2f, period: vec2i) -> vec2f {
  let i = vec2i(floor(p));
  let f = fract(p);
  var f1 = 8.0;
  var f2 = 8.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2i(x, y);
      let c = wrapCell(i + o, period);
      let pt = vec2f(o) + hashTo2(hash2i(c));
      let d = length(pt - f);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec2f(f1, f2);
}

/** 3D Worley F1. */
fn worley3(p: vec3f) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  var f1 = 8.0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let o = vec3i(x, y, z);
        let pt = vec3f(o) + vec3f(hash3i(i + o)) / 4294967295.0;
        f1 = min(f1, length(pt - f));
      }
    }
  }
  return f1;
}

/** Interleaved gradient noise, for per-pixel dithering. */
fn ign(pixel: vec2f, frame: u32) -> f32 {
  let p = pixel + 5.588238 * f32(frame % 64u);
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}
