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
