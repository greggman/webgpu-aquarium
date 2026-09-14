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
