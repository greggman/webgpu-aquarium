# A fragment shader with two `discard`s leaves NaN in the colour attachment

**Safari 26.6.2, macOS 26.6.2, Apple silicon.** Chrome on the same machine is
clean.

## Symptom

A fragment shader that writes **one constant colour** and discards some of its
pixels leaves NaN texels in the colour attachment — inside the drawn object,
interleaved with texels holding the constant. Bloom then spreads each one into
a visible block.

Every texel must be either the clear value or that constant:

- no fragment covered it → clear value;
- a fragment covered it and discarded → per WGSL, the fragment shader stage
  output is not written to any render target;
- a fragment covered it and returned → the constant.

NaN is none of those. Note WGSL zero-initialises function-scope `var`, so an
uninitialised output struct would give zeros, not NaN; initialising the outputs
before the discards explicitly makes no difference either.

## Reproduction

Live, one flag apart (needs a build at or after `d6999d0`):

```
FAILS: https://greggman.github.io/webgpu-aquarium/?only=fish&fishcut=both&watch=1
CLEAN: https://greggman.github.io/webgpu-aquarium/?only=fish&watch=1
```

`fishcut=both` restores two `discard` statements the fish shader used to have;
nothing else differs. `watch=1` reads the scene buffer back and puts the NaN
count on screen. Roughly 6,000 NaN texels over 14 s versus 0.

## The shader

`fish:render-shader`, the only one that fails. It is assembled from chunks at
runtime; the whole of it as compiled is in the appendix below. To pull it from
a running build: `__aquarium.shaders['fish:render-shader']`.

Line numbers there, counting from the first line inside the fence: `fn fs` at
920, the two discards at **956** and **1048**, `applyWater` at 354,
`waterBackground` at 372, `shadeSurface` at 580.

Where the pieces live in the tree:

| | |
| --- | --- |
| fragment entry `fn fs` | `src/sim/fish.ts:1443` |
| shader assembled | `src/sim/fish.ts:1283` (`renderWgsl`) |
| discard 1, near-lens dissolve | `src/sim/fish.ts:1478` |
| discard 2, fin webbing, inside the fin branch | `src/sim/fish.ts:1575` |
| lighting, `shadeSurface` | `src/shaders/lighting.wgsl:130` |
| fog, `applyWater` — the failing branch is the `far > 0.0` one | `src/shaders/water.wgsl:64` |
| `waterBackground` → `surfaceFromBelow` → `skyRadiance` | `src/shaders/water.wgsl:82`, `:119`, `:104` |

Both discards are compiled out entirely unless `?fishcut=both` is set; that
flag is the only difference between the two URLs above.

## Reduction

Each line is the whole fish shader with one thing changed:

| shader | result |
| --- | --- |
| both discards, unchanged | **~6,000 NaN texels / 14 s** |
| either discard alone | clean |
| both discards, output forced to a constant (shading dead) | clean |
| both discards, material built, nothing lit | clean |
| both discards, material + full lighting | clean |
| everything except the final fog call | clean |
| fog, without its distance branch | clean |
| that branch calling a shallow function of the same shape | clean |
| that branch calling the real one (sky, refraction, waves) | **FAILS** |

So it needs **two discards** *and* the whole shader's complexity. One discard
is always fine, which is why ordinary alpha-tested transparency is unaffected.
The shading must also be live — with it dead-code-eliminated, it is clean.

## Ruled out

Not the arithmetic: with outputs forced to a constant, every derivative
removed, and outputs initialised before the discards, the NaN texels still
appear. Not uniformity: the shader passes WGSL's static uniformity analysis in
all three implementations, so no derivative is in non-uniform control flow.
Not post-processing: the NaN is in the scene buffer before any of it runs.

`bugs/webkit-discard.html` is a standalone page of 13 configurations that all
**pass**, in Safari and Chrome — listed so nobody re-treads them:

1 and 2 colour attachments; `rgba16float` and `rgba8unorm`; a depth attachment
with reversed Z; 200 overlapping instances; `drawIndirect` and
`drawIndexedIndirect`; a discard pattern reseeded every frame; flat varyings
and `front_facing`; a storage-buffer read in the fragment; implicit- and
explicit-LOD texture sampling; two discards, sequential, nested in a
non-uniform branch, and in mutually exclusive branches; heavy live arithmetic
between them; and the renderer's own ~180-line fog chain (noise, waves,
absorption, in-scattering, Snell's window, sky through refraction)
transplanted verbatim with the discard count as the only variable.

Constructing upward and transplanting downward both fail to reproduce it, which
points at a threshold in shader complexity or control-flow lowering rather than
any construct that can be shown on its own. Hence the live build above as the
reproduction.

---

## Appendix: `fish:render-shader` as compiled

Exactly what the device was given, from
`?only=fish&fishcut=both&seed=221315123`. 1,072 lines: the globals and bind
group declarations, noise, the wave surface, the water chain, lighting, the
prop helpers, then the fish vertex and fragment shaders. Counting from the
first line below, the two `discard` statements are at 956 and 1048.

```wgsl


struct Frame {
  view: mat4x4f,
  proj: mat4x4f,
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  viewProjNoJitter: mat4x4f,
  prevViewProjNoJitter: mat4x4f,
  shadowViewProj: mat4x4f,
  camPos: vec3f,
  time: f32,
  sunDir: vec3f,
  frameIndex: u32,
  sunColor: vec3f,
  exposure: f32,
  absorption: vec3f,
  scattering: f32,
  ambientColor: vec3f,
  surfaceY: f32,
  resolution: vec2f,
  jitter: vec2f,
  caustics: vec4f,
  terrain: vec4f,
  shadow: vec4f,
  misc: vec4f,
  waves: array<vec4f, 12>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var sLinearRepeat: sampler;
@group(0) @binding(2) var sLinearClamp: sampler;
@group(0) @binding(3) var tShadow: texture_depth_2d;
@group(0) @binding(4) var sShadow: sampler_comparison;
@group(0) @binding(5) var tCaustics: texture_2d<f32>;
@group(0) @binding(6) var tDetail: texture_2d<f32>;
@group(0) @binding(7) var tTerrain: texture_2d<f32>;
@group(0) @binding(8) var tTerrainMask: texture_2d<f32>;
@group(0) @binding(9) var tContact: texture_2d<f32>;

/**
 * How far a fragment moved on screen since the last frame, for TAA.
 *
 * A point that is in front of the camera now may have been behind it last
 * frame, and then its previous w is zero or negative and the perspective
 * divide means nothing: the answer runs off to infinity, or is a plain
 * division by zero. TAA has no defence against that — its bounds test is a
 * pair of comparisons that are both false for a NaN, so the bad value passes
 * the test, skips the neighbourhood clip, and is written into the history,
 * where it is read back and rewritten every frame after. One fragment latches
 * a texel permanently. Report no motion instead; a point that was off-screen
 * has no usable history anyway.
 */
fn screenVelocity(cur: vec4f, prev: vec4f) -> vec2f {
  if (cur.w <= 0.0 || prev.w <= 0.0) {
    return vec2f(0.0);
  }
  return (cur.xy / cur.w - prev.xy / prev.w) * vec2f(0.5, -0.5);
}

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


fn waveData(i: u32) -> vec4f { return frame.waves[i]; }
fn wavePhaseSeed() -> f32 { return frame.misc.w; }
// Water surface waves: a sum of travelling cosines whose wave vectors are
// integer multiples of 2*pi/tile, so the pattern (and its caustics) tiles.
// Requires `waves: array<vec4f, 12>` and `wavePhaseSeed: f32` to be provided
// by the including shader (see waveData()).

struct WaveSample {
  h: f32,
  grad: vec2f,
  /** Hessian (xx, xz, zz). */
  hess: vec3f,
};

fn sampleWaves(xz: vec2f, t: f32) -> WaveSample {
  var o = WaveSample(0.0, vec2f(0.0), vec3f(0.0));
  for (var i = 0u; i < 12u; i++) {
    let w = waveData(i);
    let k = w.xy;
    let theta = dot(k, xz) - w.w * t + f32(i) * 2.39996 + wavePhaseSeed();
    let c = cos(theta);
    let s = sin(theta);
    o.h += w.z * c;
    o.grad -= w.z * s * k;
    o.hess -= w.z * c * vec3f(k.x * k.x, k.x * k.y, k.y * k.y);
  }
  return o;
}

/** Surface normal (pointing up) from the wave gradient. */
fn waveNormal(xz: vec2f, t: f32, strength: f32) -> vec3f {
  let s = sampleWaves(xz, t);
  return normalize(vec3f(-s.grad.x * strength, 1.0, -s.grad.y * strength));
}


// Underwater light transport: absorption, scattering, sunlight at depth.
// Requires the globals chunk (frame uniform).

const PI = 3.14159265;

fn depthBelowSurface(y: f32) -> f32 {
  return max(frame.surfaceY - y, 0.0);
}

fn extinction() -> vec3f {
  return frame.absorption + vec3f(frame.scattering);
}

/** Direct sunlight reaching height y, after travelling down through the water. */
fn sunAtDepth(y: f32) -> vec3f {
  let path = depthBelowSurface(y) / max(frame.sunDir.y, 0.25);
  // Light paths are attenuated less than view paths (forward scattering keeps
  // sunlight travelling down), and red is relaxed most so shallow reefs keep
  // their warm colours as in the reference games.
  let k = frame.absorption * vec3f(0.3, 0.55, 0.6) + vec3f(frame.scattering * 0.3);
  return frame.sunColor * exp(-k * path);
}

/** Diffuse downwelling light (the blue glow from everywhere above) at height y. */
fn ambientAtDepth(y: f32) -> vec3f {
  return frame.ambientColor * exp(-extinction() * 0.5 * depthBelowSurface(y));
}

fn phaseHG(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

/** Water's forward-peaked phase function: strong forward lobe plus a broad one. */
fn waterPhase(cosTheta: f32) -> f32 {
  return mix(phaseHG(cosTheta, 0.2), phaseHG(cosTheta, 0.85), 0.35);
}

/**
 * The colour a long path through the water saturates to at height y when looking
 * along `dir`: in-scattered sun + ambient, divided by extinction.
 */
fn inscatterColor(y: f32, dir: vec3f) -> vec3f {
  let sun = sunAtDepth(y) * waterPhase(dot(dir, frame.sunDir)) * 4.0 * PI;
  let amb = ambientAtDepth(y);
  // Looking down, the water beneath is darker; looking up, brighter.
  let updown = mix(0.1, 1.3, smoothstep(-0.9, 0.9, dir.y));
  return frame.scattering * (sun * 0.06 + amb * updown * 0.5) / extinction();
}

/** Fog factor pieces for a path of length `dist` from the camera along `dir`. */
fn waterTransmittance(dist: f32) -> vec3f {
  // The first couple of metres are kept nearly clear so close subjects stay
  // crisp and saturated; beyond that the full absorption takes over.
  let d = max(dist - 2.5, 0.0) + min(dist, 2.5) * 0.3;
  // Red is absorbed along the view path at its full physical rate even though
  // the overall fog is thinned for readability: warm colours go blue-grey by
  // mid-distance, the strongest depth cue underwater.
  let k = extinction() * frame.misc.z + vec3f(frame.absorption.r * (1.0 - frame.misc.z), 0.0, 0.0);
  return exp(-k * d);
}

/** Applies absorption and in-scattering between the camera and a lit surface point. */
fn applyWater(color: vec3f, worldPos: vec3f) -> vec3f {
  let toP = worldPos - frame.camPos;
  let dist = length(toP);
  let dir = toP / max(dist, 1e-4);
  let T = waterTransmittance(dist);
  let ymid = mix(frame.camPos.y, worldPos.y, 0.5);
  var c = color * T + inscatterColor(ymid, dir) * (1.0 - T);
  // Far away, dissolve into exactly the open-water backdrop so distant ridges
  // and sunlit slopes never silhouette as a painted cut-out.
  let typical = 1.0 / max(extinction().g, 1e-3);
  let far = smoothstep(typical * 1.4, typical * 3.0, dist);
  if (far > 0.0) {
    c = mix(c, waterBackground(dir), far);
  }
  return c;
}

/** What you see along `dir` when nothing is in the way. */
fn waterBackground(dir: vec3f) -> vec3f {
  let camY = frame.camPos.y;
  // Height where the view ray has lost most of its light (about one extinction length).
  let typical = 1.0 / max(extinction().g, 1e-3);
  if (dir.y > 0.0) {
    let toSurface = (frame.surfaceY - camY) / dir.y;
    let d = min(toSurface, typical * 3.0);
    let y = mix(camY, camY + dir.y * d, 0.5);
    let T = waterTransmittance(toSurface);
    return surfaceFromBelow(dir) * T + inscatterColor(y, dir) * (1.0 - T);
  }
  let y = camY + dir.y * typical;
  return inscatterColor(y, dir);
}

/** Direction toward the sun in the air above the water. */
fn sunDirAir() -> vec3f {
  let r = refract(frame.sunDir, vec3f(0.0, -1.0, 0.0), 1.333);
  return normalize(r + vec3f(0.0, 1e-4, 0.0));
}

/** Sky radiance above the water along `d` (d.y > 0). */
fn skyRadiance(d: vec3f) -> vec3f {
  let sunAir = sunDirAir();
  let mu = max(dot(d, sunAir), 0.0);
  let horizon = frame.ambientColor * vec3f(1.6, 1.5, 1.35) * 2.2;
  let zenith = frame.ambientColor * vec3f(0.8, 1.0, 1.25) * 1.8;
  var sky = mix(horizon, zenith, pow(clamp(d.y, 0.0, 1.0), 0.6));
  // Soft drifting clouds, seen distorted through the waves.
  let cloudUv = d.xz / max(d.y, 0.15) * 1.3 + vec2f(frame.time * 0.004, 0.0);
  let clouds = smoothstep(0.05, 0.55, fbm2(cloudUv, 4) + 0.15);
  sky = mix(sky, vec3f(dot(sky, vec3f(0.33)) * 1.5), clouds * 0.55);
  sky += frame.sunColor * (pow(mu, 1500.0) * 22.0 + pow(mu, 60.0) * 1.6 + pow(mu, 6.0) * 0.3);
  return sky;
}

/** Radiance of the wavy water surface seen from below at the point hit along `dir`. */
fn surfaceFromBelow(dir: vec3f) -> vec3f {
  let t = (frame.surfaceY - frame.camPos.y) / max(dir.y, 1e-3);
  let hit = frame.camPos.xz + dir.xz * t;
  // Two scales of the tiling waves, the second rotated to break repetition.
  let w0 = sampleWaves(hit, frame.time);
  let rot = mat2x2f(0.8, 0.6, -0.6, 0.8);
  let w1 = sampleWaves(rot * hit * 0.37 + vec2f(3.1, 1.7), frame.time * 0.6);
  // Wind chop on top of the swell: a finer, faster copy of the waves in a third
  // orientation plus small drifting capillary ripples, so the surface never
  // reads as a glassy sheet.
  let rot2 = mat2x2f(-0.28, 0.96, -0.96, -0.28);
  let w2 = sampleWaves(rot2 * hit * 2.6 + vec2f(-5.3, 2.2), frame.time * 1.7);
  let ripUv = hit * 1.9 + vec2f(frame.time * 0.35, -frame.time * 0.22);
  let e = 0.05;
  let n0 = fbm2(ripUv, 3);
  let ripple = vec2f(fbm2(ripUv + vec2f(e, 0.0), 3) - n0, fbm2(ripUv + vec2f(0.0, e), 3) - n0) / e;
  // Distant surface looks flatter (normals average out) and the fine ripples
  // wash out first, which keeps the edge of Snell's window soft.
  let fade = 1.0 / (1.0 + t * 0.07);
  let fineFade = 1.0 / (1.0 + t * 0.2);
  let g = (w0.grad * 2.6 * fade + (transpose(rot) * w1.grad) * 2.0 +
    (transpose(rot2) * w2.grad) * 1.2 * fineFade + ripple * 0.12 * fineFade) * mix(0.6, 1.0, fade);
  let n = normalize(vec3f(-g.x, -1.0, -g.y)); // facing down, toward the viewer

  let cosI = clamp(dot(-dir, n), 0.0, 1.0);
  let r = reflect(dir, n);
  // Outside the window the surface mirrors the dim water and reef below:
  // darker, with slow mottling so it isn't a flat sheet.
  let mottle = fbm2(hit * 0.08 + r.xz * 2.0, 3);
  let reflected = inscatterColor(frame.surfaceY - 8.0, r) * (0.65 + 0.35 * mottle);
  // Blend across the critical angle instead of switching abruptly.
  let sinT2 = 1.333 * 1.333 * (1.0 - cosI * cosI);
  let window = smoothstep(1.0, 0.82, sinT2);
  let cosT = sqrt(max(1.0 - sinT2, 1e-4));
  let rs = (1.333 * cosI - cosT) / (1.333 * cosI + cosT);
  let rp = (cosI - 1.333 * cosT) / (cosI + 1.333 * cosT);
  let F = clamp(0.5 * (rs * rs + rp * rp), 0.0, 1.0);
  let refr = normalize(refract(dir, n, 1.333) + vec3f(0.0, 1e-3, 0.0));
  let through = mix(skyRadiance(refr), reflected, F);
  return mix(reflected, through, window);
}

// Physically based shading adapted for underwater light.
// Requires globals, noise and water chunks.

struct Surface {
  albedo: vec3f,
  roughness: f32,
  normal: vec3f,
  metallic: f32,
  emissive: vec3f,
  ao: f32,
  /** 0 = opaque, 1 = thin translucent (fins, kelp, membranes). */
  translucency: f32,
  /** Specular reflectance at normal incidence (dielectrics ~0.02-0.05). */
  f0: f32,
};

fn defaultSurface() -> Surface {
  return Surface(vec3f(0.5), 0.8, vec3f(0.0, 1.0, 0.0), 0.0, vec3f(0.0), 1.0, 0.0, 0.03);
}

fn D_GGX(NoH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let f = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / (PI * f * f + 1e-7);
}

fn V_SmithGGXCorrelated(NoV: f32, NoL: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  let gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / (gv + gl + 1e-5);
}

fn F_Schlick(u: f32, f0: vec3f) -> vec3f {
  let f = pow(1.0 - u, 5.0);
  return f0 + (vec3f(1.0) - f0) * f;
}

/** Soft sun shadow (PCF over the comparison sampler). 1 = lit. */
fn sunShadow(worldPos: vec3f, normal: vec3f) -> f32 {
  let texel = frame.shadow.x;
  if (texel <= 0.0) {
    return 1.0;
  }
  let biased = worldPos + normal * texel * 1.5 + frame.sunDir * texel * 1.0;
  let clip = frame.shadowViewProj * vec4f(biased, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + 0.5;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z < 0.0) {
    return 1.0;
  }
  let res = frame.shadow.y;
  let texelStep = 1.0 / res;
  // Rotated-disk PCF: water scatters light so shadows are soft.
  let angle = ign(worldPos.xz * 37.0, 0u) * 6.2831853;
  let rot = mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle));
  var sum = 0.0;
  var taps = array<vec2f, 8>(
    vec2f(-0.94, -0.40), vec2f(0.95, -0.77), vec2f(-0.09, -0.93), vec2f(0.34, 0.29),
    vec2f(-0.61, 0.49), vec2f(0.63, 0.81), vec2f(-0.21, 0.02), vec2f(0.53, -0.29),
  );
  for (var i = 0; i < 8; i++) {
    let o = rot * taps[i] * texelStep * 1.8;
    sum += textureSampleCompareLevel(tShadow, sShadow, uv + o, ndc.z);
  }
  let edge = smoothstep(0.0, 0.1, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
  return mix(1.0, sum / 8.0, edge);
}

/** World-space position where the sun ray through `p` entered the water. */
fn surfaceEntry(p: vec3f) -> vec2f {
  let t = depthBelowSurface(p.y) / max(frame.sunDir.y, 0.25);
  return p.xz + frame.sunDir.xz * t;
}

/** Caustic light multiplier at a point (averages ~1). */
fn causticsAt(p: vec3f, normal: vec3f) -> vec3f {
  let scale = frame.caustics.x;
  if (scale <= 0.0) {
    return vec3f(1.0);
  }
  let depth = depthBelowSurface(p.y);
  let uv = surfaceEntry(p) / scale;
  let dist = length(p - frame.camPos);
  // Deeper points see blurrier caustics (the focal lines spread out), and
  // distant ones are filtered so they don't shimmer.
  // Blurrier on slopes too, so tilted surfaces get soft moving patches rather
  // than a crisp web of lines.
  let tilt = 1.0 - clamp(normal.y, 0.0, 1.0);
  let lod = clamp(log2(1.0 + depth * 0.1) + log2(1.0 + dist * 0.06) + tilt * 2.5 - frame.caustics.w, 0.0, 6.0);
  // Two rotated, rescaled samples multiplied together hide the tiling.
  let rot = mat2x2f(0.8, 0.6, -0.6, 0.8);
  let c1 = textureSampleLevel(tCaustics, sLinearRepeat, uv, lod).rgb;
  let c2 = textureSampleLevel(tCaustics, sLinearRepeat, rot * uv * 0.73 + 0.31, lod).rgb;
  // Soft-compress the focal lines so they sparkle without blowing out.
  // The geometric mean of two uncorrelated patterns loses contrast: restore
  // it so the focal network reads as bright lines over darker cells.
  let raw = pow(sqrt(c1 * c2), vec3f(1.7)) * 1.35;
  // Peaks roll off: close to the camera the focal lines are sharp and
  // would otherwise blow out into white blotches on bright sand.
  let c = raw / (1.0 + max(raw - vec3f(1.1), vec3f(0.0)) * 0.5);
  // Distance and slope both mute the pattern: far floors would otherwise read
  // as a tiled web, and slopes as bright white netting.
  let fade = frame.caustics.y * exp(-depth / frame.caustics.z) * exp(-dist * 0.015) *
    mix(1.0, 0.4, smoothstep(18.0, 45.0, dist)) * mix(1.0, 0.5, smoothstep(0.2, 0.6, tilt));
  // The swell focusing overhead brightens and dims the pattern with the surge.
  let sk = dot(p.xz, normalize(vec2f(1.0, 0.35))) * 0.11;
  let pulse = 1.0 + 0.22 * sin(frame.time * 0.9 - sk + 1.2);
  // Only surfaces facing the sun catch the pattern; steep faces would smear it.
  let facing = smoothstep(0.35, 0.85, dot(normal, frame.sunDir));
  return mix(vec3f(1.0), c * pulse, fade * facing);
}

struct GroundInfo {
  /** Terrain height under the point. */
  height: f32,
  /** Visibility left by nearby props (1 = open), faded out above the ground. */
  contact: f32,
};

fn groundInfo(p: vec3f) -> GroundInfo {
  let uv = p.xz / frame.terrain.x + 0.5;
  let ground = textureSampleLevel(tTerrain, sLinearClamp, uv, 0.0).r;
  let c = textureSampleLevel(tContact, sLinearClamp, uv, 0.0).r;
  let nearGround = smoothstep(0.5, 0.0, p.y - ground);
  return GroundInfo(ground, mix(1.0, c, nearGround));
}

/** Full lighting for a surface point. Returns radiance before water fog. */
fn shadeSurface(s: Surface, p: vec3f, shadowOverride: f32) -> vec3f {
  let toEye = frame.camPos - p;
  let V = select(vec3f(0.0, 0.0, 1.0), normalize(toEye), dot(toEye, toEye) > 1e-12);
  let N = s.normal;
  let L = frame.sunDir;
  // V + L cancels when the surface is looked at from exactly opposite the sun,
  // which here means from below with the sun overhead — a camera under a fish,
  // and the sun is always steeply overhead. The half vector is undefined
  // there; L is the limit approached from either side.
  let VL = V + L;
  let H = select(L, normalize(VL), dot(VL, VL) > 1e-12);
  let NoV = max(dot(N, V), 1e-4);
  let NoLraw = dot(N, L);
  let NoL = max(NoLraw, 0.0);
  let NoH = max(dot(N, H), 0.0);
  let VoH = max(dot(V, H), 0.0);

  var shadow = shadowOverride;
  if (shadow < 0.0) {
    shadow = sunShadow(p, N);
  }
  // Where props meet the ground, both sky light and scattered sunlight are
  // partly blocked: sand darkens against rocks, and their bases sink in.
  let gi = groundInfo(p);
  let contact = gi.contact;
  let sun = sunAtDepth(p.y) * shadow * causticsAt(p, N) * mix(1.0, contact, 0.2);

  let a = max(s.roughness * s.roughness, 0.002);
  let f0 = mix(vec3f(s.f0), s.albedo, s.metallic);
  let F = F_Schlick(VoH, f0);
  let spec = D_GGX(NoH, a) * V_SmithGGXCorrelated(NoV, NoL, a) * F;
  let kd = (vec3f(1.0) - F) * (1.0 - s.metallic);

  // Wrapped diffuse for translucent things so light bleeds around the edge.
  let wrap = s.translucency * 0.5;
  let diffuseNoL = max((NoLraw + wrap) / ((1.0 + wrap) * (1.0 + wrap)), 0.0);
  var color = (kd * s.albedo / PI * diffuseNoL + spec * NoL) * sun;

  // Light passing through thin tissue (kelp blades, fins, jelly, fans): light
  // striking the far side transmits, strongly when looking toward the sun, and
  // comes out saturated because it travelled through the pigment.
  let amb = ambientAtDepth(p.y);
  let transColor = s.albedo * (s.albedo * 1.6 + vec3f(0.15));
  let backFace = max(-NoLraw, 0.0);
  let towardSun = pow(max(dot(-V, L), 0.0), 4.0);
  color += transColor * s.translucency * sun * (backFace * 0.55 + towardSun * 2.0);
  // The bright water surface above also shines through undersides.
  color += transColor * s.translucency * amb * max(-N.y, 0.0) * 0.8;

  // Ambient: blue from above, and from below warm light bounced off the sunlit
  // sand (strongest close to the bottom), so undersides aren't dead cutouts.
  let lift = smoothstep(6.0, 0.0, p.y - gi.height);
  let bounce = sunAtDepth(gi.height) * vec3f(0.66, 0.58, 0.44) * mix(0.05, 0.32, lift);
  let hemi = mix(bounce, amb, N.y * 0.5 + 0.5);
  color += kd * s.albedo * hemi * s.ao * contact;

  // Specular ambient: water colour reflected at grazing angles.
  let R = reflect(-V, N);
  // Rough surfaces scatter the reflection away; only smooth ones mirror the water.
  let Fa = F_Schlick(NoV, f0) * pow(1.0 - s.roughness, 1.5);
  color += Fa * inscatterColor(p.y, R) * s.ao * contact * 0.6;

  // The scene buffer is rgba16float, which stops at 65504. A highlight on
  // something nearly mirror-smooth can pass that — the sun is a point, so its
  // reflection has no width to spread energy over — and what reaches the
  // texture is an infinity. Bloom weights each tap by the inverse of its
  // brightness to keep single bright pixels from taking over, and that weight
  // is zero for an infinity, so the tap becomes inf * 0, which is NaN, and one
  // pixel comes back as a block. Keep the result well inside the format.
  return min(color + s.emissive, vec3f(4096.0));
}

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
  let lod = log2(max(fw * scale * f32(textureDimensions(tDetail, 0).x), 1.0));
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

struct Species {
  band: vec4f,
  flock: vec4f,
  motion: vec4f,
  colTop: vec4f,
  colBelly: vec4f,
  colAccent: vec4f,
  colFin: vec4f,
  extra: vec4f,
  behavior: vec4f,
  dart: vec4f,
  school: vec4f,
};

struct FishInstance {
  posScale: vec4f,
  rot: vec4f,
  prevPosScale: vec4f,
  prevRot: vec4f,
  anim: vec4f,
  tint: vec4f,
};

@group(1) @binding(0) var<storage, read> instances: array<FishInstance>;
@group(1) @binding(1) var<storage, read> species: array<Species>;
@group(1) @binding(2) var<storage, read> visible: array<u32>;
struct DrawInfo {
  /** Start of this draw's run of fish indices (or first fish, if direct). */
  base: u32,
  /** 1: instance index + base is the fish index (no visibility list). */
  direct: u32,
};
@group(1) @binding(3) var<uniform> drawInfo: DrawInfo;

fn fishIndex(instance: u32) -> u32 {
  return select(visible[drawInfo.base + instance], drawInfo.base + instance, drawInfo.direct == 1u);
}

fn quatRotate(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

struct VIn {
  @location(0) position: vec4f,
  @location(1) normal: vec4f,
  @location(2) uv: vec4f,
  @builtin(instance_index) instance: u32,
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec4f,
  @location(3) local: vec3f,
  @location(4) @interpolate(flat) instance: u32,
  @location(5) ao: f32,
  @location(6) curClip: vec4f,
  @location(7) prevClip: vec4f,
};

fn swim(p: vec3f, uv: vec4f, phase: f32, speedNorm: f32, sp: Species) -> vec3f {
  let part = u32(uv.w + 0.5);
  let bodyV = uv.z;
  var q = p;
  if (sp.motion.z > 0.5) {
    // Rays flap their wings in a wave travelling back along the body.
    let span = abs(p.x) / 0.6;
    q.y += sin(phase * 6.2831853 - bodyV * 2.2) * pow(span, 1.6) * 0.16;
    q.x *= 1.0 - pow(span, 2.0) * 0.08 * (0.5 + 0.5 * sin(phase * 6.2831853 - bodyV * 2.2));
    if (part == 8u) {
      q.x += sin(phase * 3.0 - bodyV * 4.0) * (bodyV - 1.0) * 0.06;
    }
    return q;
  }
  // Travelling body wave; amplitude grows toward the tail.
  let k = 6.2831853 * 0.9;
  let amp = (0.02 + 0.1 * bodyV * bodyV) * (0.55 + 0.45 * speedNorm);
  q.x += amp * sin(bodyV * k - phase * 6.2831853);
  if (part == 4u || part == 5u) {
    // Pectoral fins row gently.
    let flap = sin(phase * 3.14159 + select(0.0, 3.14159, part == 5u)) * 0.5 + 0.3;
    q.x += sign(p.x) * uv.y * 0.02 * flap;
    q.z -= uv.y * 0.02 * flap;
  }
  if (part == 2u || part == 3u) {
    q.x += sin(phase * 6.2831853 * 0.7 - uv.x * 4.0) * uv.y * 0.01;
  }
  return q;
}

@vertex
fn vs(v: VIn) -> VOut {
  let fish = fishIndex(v.instance);
  let inst = instances[fish];
  let sp = species[u32(inst.anim.w)];
  let local = swim(v.position.xyz, v.uv, inst.anim.x, inst.anim.z, sp);
  let prevLocal = swim(v.position.xyz, v.uv, inst.anim.y, inst.anim.z, sp);
  // A fish that swims right up to the lens is taken away rather than left to
  // fill the frame with a wall of blurred scales. It used to be dithered out
  // per pixel, which needs discard, and a fish shader that discards leaves
  // undefined values in the colour target in WebKit. Shrinking it to nothing
  // here does the same job: at zero every triangle of the fish has no area, so
  // none of them are drawn, and the shader never has to refuse a fragment.
  let nearest = length(frame.camPos - inst.posScale.xyz) - inst.posScale.w * 0.6;
  let shrink = smoothstep(0.35, 0.9, nearest);
  let world = quatRotate(inst.rot, local * inst.posScale.w * shrink) + inst.posScale.xyz;
  let prevWorld = quatRotate(inst.prevRot, prevLocal * inst.prevPosScale.w * shrink) + inst.prevPosScale.xyz;
  var o: VOut;
  o.pos = frame.viewProj * vec4f(world, 1.0);
  o.world = world;
  o.normal = quatRotate(inst.rot, v.normal.xyz);
  o.uv = v.uv;
  o.local = v.position.xyz;
  o.instance = fish;
  o.ao = v.position.w;
  o.curClip = frame.viewProjNoJitter * vec4f(world, 1.0);
  o.prevClip = frame.prevViewProjNoJitter * vec4f(prevWorld, 1.0);
  return o;
}

@vertex
fn vsShadow(v: VIn) -> @builtin(position) vec4f {
  let inst = instances[fishIndex(v.instance)];
  let sp = species[u32(inst.anim.w)];
  let local = swim(v.position.xyz, v.uv, inst.anim.x, inst.anim.z, sp);
  let world = quatRotate(inst.rot, local * inst.posScale.w) + inst.posScale.xyz;
  return frame.shadowViewProj * vec4f(world, 1.0);
}

fn fishPattern(sp: Species, i: VOut, n: vec3f) -> vec3f {
  let u = i.uv.x;
  let v = i.uv.y;
  let sideUp = sin(u * 6.2831853);
  var c = mix(sp.colBelly.rgb, sp.colTop.rgb, smoothstep(-0.35, 0.45, sideUp));
  let kind = u32(sp.colTop.w + 0.5);
  let freq = sp.colBelly.w;
  switch (kind) {
    case 1u: {
      let b = smoothstep(0.35, 0.45, abs(fract(v * freq + 0.3) - 0.5));
      c = mix(c, sp.colAccent.rgb, (1.0 - b) * smoothstep(0.1, 0.25, v));
    }
    case 2u: {
      let stripe = smoothstep(0.18, 0.05, abs(sideUp - 0.12));
      c = mix(c, sp.colAccent.rgb, stripe * 0.8);
    }
    case 3u: {
      let w = worley2p(vec2f(v * freq, u * freq * 2.0), vec2i(0)).x;
      c = mix(c, sp.colAccent.rgb, smoothstep(0.35, 0.2, w) * 0.8);
    }
    case 4u: {
      c = mix(c, sp.colAccent.rgb, smoothstep(0.2, 0.9, v) * 0.7);
    }
    case 5u: {
      var band = 0.0;
      var centers = array<f32, 3>(0.22, 0.52, 0.86);
      for (var k = 0; k < 3; k++) {
        let center = centers[k];
        let d = abs(v - center);
        band = max(band, smoothstep(0.06, 0.04, d));
        // Thin black edge.
        c = mix(c, vec3f(0.02), smoothstep(0.075, 0.06, d) * (1.0 - smoothstep(0.06, 0.05, d)));
      }
      c = mix(c, sp.colAccent.rgb, band);
    }
    default: {}
  }
  return c;
}

struct FOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
};

@fragment
fn fs(i: VOut, @builtin(front_facing) front: bool) -> FOut {
  // Declared and filled in before anything can discard. A discarded fragment
  // must not write, so what the outputs hold ought not to matter — but leaving
  // them undefined at the point of the discard is what put NaNs on the screen
  // in Safari, in blocks, once bloom had spread them.
  var o: FOut;
  o.color = vec4f(0.0, 0.0, 0.0, 1.0);
  o.velocity = vec2f(0.0);
  let toEye = frame.camPos - i.world;
  let V = select(
    vec3f(0.0, 0.0, 1.0),
    normalize(toEye),
    dot(toEye, toEye) > 1e-12,
  );
  // The mesh's normals collapse to zero in places — a fin's tip, a pole of the
  // body's parameterisation — and normalize(0) is a NaN, which bloom then
  // spreads across the screen as a block. Nudging such a normal away from zero
  // only trades one fault for another: the direction that comes out is
  // arbitrary, and an arbitrary normal catches the sun square-on often enough
  // to flash white. The triangle being drawn always has a normal of its own,
  // so use that instead, turned to face the viewer. Derivatives have to be
  // taken outside the branch: WGSL only allows them in uniform control flow.
  let cross2 = cross(dpdxFine(i.world), dpdyFine(i.world));
  var geo = select(V, normalize(cross2), dot(cross2, cross2) > 1e-20);
  if (dot(geo, V) < 0.0) {
    geo = -geo;
  }
  var n = select(geo, normalize(i.normal), dot(i.normal, i.normal) > 1e-10);
  if (!front) {
    n = -n;
  }
  let inst = instances[i.instance];
  let sp = species[u32(inst.anim.w)];
  let part = u32(i.uv.w + 0.5);
  let camDist = length(frame.camPos - i.world);
  if (ign(i.pos.xy, frame.frameIndex * 5u + i.instance) > smoothstep(0.35, 1.1, camDist)) {
    discard;
  }
  var s = defaultSurface();
  // How much of this pixel is gaps rather than tissue (fin webbing).
  var seeThrough = 0.0;
  s.normal = n;
  s.ao = i.ao;
  s.f0 = 0.04;

  let isRay = sp.motion.z > 0.5;
  if (part == 0u || part == 6u || part == 7u) {
    var c = fishPattern(sp, i, n) * inst.tint.rgb;
    if (isRay) {
      let top = part == 6u;
      c = select(sp.colBelly.rgb, sp.colTop.rgb, top);
      if (top && u32(sp.colTop.w + 0.5) == 3u) {
        let w = worley2p(i.local.xz * 14.0, vec2i(0)).x;
        c = mix(c, sp.colAccent.rgb, smoothstep(0.3, 0.15, w));
      }
    }
    // Scales: overlapping rows (offset every other row) that catch the light,
    // a darker lateral line, and a subtle mottling so colour isn't flat.
    let row = floor(i.uv.y * 55.0);
    let scaleUv = vec2f(i.uv.y * 55.0, i.uv.x * 38.0 + row * 0.5);
    let cell = fract(scaleUv);
    let scaleEdge = smoothstep(0.55, 0.95, length(cell - vec2f(0.2, 0.5)));
    let lateral = smoothstep(0.035, 0.0, abs(sin(i.uv.x * 6.2831853) - 0.08)) * smoothstep(0.12, 0.3, i.uv.y);
    let mottle = fbm2(vec2f(i.uv.y * 9.0, i.uv.x * 14.0), 3);
    let rim = pow(1.0 - max(dot(n, V), 0.0), 2.0);
    let irid = palette(dot(n, V) * 1.3 + i.uv.y, vec3f(0.5), vec3f(0.5), vec3f(1.0), vec3f(0.0, 0.33, 0.67));
    // Backs are darker and less saturated than the pattern suggests, as on real fish.
    let back = smoothstep(0.3, 0.9, sin(i.uv.x * 6.2831853));
    c = mix(c, c * vec3f(0.3, 0.36, 0.42), back * 0.85);
    // Pale belly.
    let belly = smoothstep(-0.2, -0.85, sin(i.uv.x * 6.2831853));
    c = mix(c, mix(c, vec3f(0.85, 0.85, 0.8), 0.55), belly);
    s.albedo = c * (0.9 + 0.12 * mottle) * mix(1.0, 0.8, scaleEdge) * mix(1.0, 0.7, lateral);
    // Guanine platelets: a colour-shifting sheen that follows the viewing
    // angle, strongest on flanks lit from above.
    let flank = smoothstep(-0.3, 0.6, n.y + 0.3);
    s.emissive = irid * (rim * 0.6 + 0.1) * sp.colAccent.w * flank * 0.008 * sunAtDepth(i.world.y);
    // Satin, not lacquer: broad soft highlights with scale sparkle on top.
    s.roughness = mix(0.55, 0.22, sp.colAccent.w);
    // Silvery flanks mirror the water; the dark back stays matte, so a school
    // seen from above reads as dark bodies rather than glassy grey shapes.
    s.f0 = mix(0.04, 0.09, sp.colAccent.w) * mix(1.0, 0.4, back);
    s.roughness = mix(s.roughness, 0.6, back);
    // Each scale is tilted a little differently, so highlights flash across
    // the body as the fish turns (strongest on silvery species).
    let cellId = floor(scaleUv);
    let h1 = fract(sin(dot(cellId, vec2f(12.9898, 78.233))) * 43758.5453);
    let h2 = fract(h1 * 17.13 + 0.37);
    let tilt = vec3f(h1 - 0.5, h2 - 0.5, (h1 + h2) * 0.5 - 0.5) * (0.25 + 0.6 * sp.colAccent.w);
    let bumped = bumpNormal(n, vec3f(0.0, scaleEdge - 0.5, 0.0) * 0.04) +
      tilt * 0.5;
    s.normal = select(n, normalize(bumped), dot(bumped, bumped) > 1e-10);
    // Face: gill cover edge behind the eye, darker snout and mouth line, then the eye.
    if (!isRay) {
      let gill = smoothstep(0.012, 0.0, abs(i.uv.y - 0.2 - sin(i.uv.x * 6.2831853) * 0.015)) * smoothstep(0.9, 0.3, abs(sin(i.uv.x * 6.2831853)));
      s.albedo *= 1.0 - gill * 0.45;
      let snout = smoothstep(0.08, 0.0, i.uv.y);
      s.albedo *= 1.0 - snout * 0.35;
      let mouth = smoothstep(0.01, 0.0, abs(i.local.y + 0.01)) * smoothstep(0.06, 0.0, i.uv.y);
      s.albedo *= 1.0 - mouth * 0.7;
      let eyeZ = 0.5 - 0.1;
      let d = length(vec2f(i.local.z - eyeZ, i.local.y - sp.extra.z));
      // Only on the flanks: the (z, y) disc would otherwise band over the
      // top of the head and read as a glowing snout from above.
      let flankOnly = smoothstep(0.45, 0.75, abs(cos(i.uv.x * 6.2831853)));
      let eye = smoothstep(sp.extra.w, sp.extra.w * 0.8, d) * flankOnly;
      let pupil = smoothstep(sp.extra.w * 0.6, sp.extra.w * 0.45, d) * smoothstep(0.45, 0.75, abs(cos(i.uv.x * 6.2831853)));
      // A dark socket ring, a gold iris and a large black pupil with a catch
      // light: the eye is what makes a fish read as an animal.
      let socket = smoothstep(sp.extra.w * 1.45, sp.extra.w * 1.05, d) * flankOnly;
      s.albedo *= 1.0 - socket * 0.45;
      // Iris: gold on big fish, silvery on small ones.
      s.albedo = mix(s.albedo, mix(vec3f(0.45, 0.47, 0.5), vec3f(0.8, 0.68, 0.28), smoothstep(0.25, 0.45, sp.motion.y)), eye);
      s.albedo = mix(s.albedo, vec3f(0.005), pupil);
      s.roughness = mix(s.roughness, 0.05, eye);
    }
  } else {
    // Fins: a thin membrane stretched between bony rays. The membrane is
    // genuinely see-through: stochastic (dithered) transparency that TAA
    // resolves into a soft, partially transparent fin; the rays stay denser.
    let rayLine = smoothstep(0.7, 0.97, sin(i.uv.x * 48.0) * 0.5 + 0.5);
    let edgeFade = 1.0 - smoothstep(0.7, 1.0, i.uv.y) * 0.6;
    // How much of the membrane is actually there. This used to dither the fin
    // away per pixel so it read as see-through; without discard the fin stays
    // solid, so the same number drives how much light passes through it
    // instead. The webbing between the rays transmits nearly everything.
    let webbing = mix(0.3 + 0.35 * (1.0 - sp.colFin.w), 0.95, rayLine) * edgeFade;
    if (ign(i.pos.xy, frame.frameIndex * 7u + i.instance) > webbing) {
      discard;
    }
    // Fins carry a little of the body colour and glow only softly when backlit.
    s.albedo = mix(sp.colFin.rgb, sp.colTop.rgb, 0.3) * mix(0.85, 1.0, rayLine) * inst.tint.rgb;
    s.translucency = max(sp.colFin.w, 0.6) * 0.55;
    seeThrough = 1.0 - webbing;
    s.roughness = 0.45;
    if (part == 1u && u32(sp.colTop.w + 0.5) == 5u) {
      s.albedo = mix(s.albedo, vec3f(0.02), smoothstep(0.8, 0.95, i.uv.y));
    }
  }

  var lit = shadeSurface(s, i.world, -1.0);
  // The webbing between a fin's rays is mostly holes, and used to be dithered
  // out per pixel so the water showed through. Without discard the fin is
  // solid, so put the water back the only way left: mix in the colour that
  // would have arrived through the gaps. Fins are thin and nearly always seen
  // against open water, so the water's own colour is a fair stand-in.
  lit = mix(lit, inscatterColor(i.world.y, -V), seeThrough * 0.75);
  let watered = applyWater(lit, i.world);
  o.color = vec4f(watered, 1.0);
  o.velocity = screenVelocity(i.curClip, i.prevClip);
  return o;
}
```
