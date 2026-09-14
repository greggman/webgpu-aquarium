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
  // Light paths are attenuated a little less than view paths: forward
  // scattering keeps sunlight travelling downward.
  return frame.sunColor * exp(-extinction() * path * 0.6);
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
  let updown = mix(0.35, 1.25, smoothstep(-0.8, 0.9, dir.y));
  return frame.scattering * (sun * 0.12 + amb * updown) / extinction();
}

/** Fog factor pieces for a path of length `dist` from the camera along `dir`. */
fn waterTransmittance(dist: f32) -> vec3f {
  return exp(-extinction() * dist * frame.misc.z);
}

/** Applies absorption and in-scattering between the camera and a lit surface point. */
fn applyWater(color: vec3f, worldPos: vec3f) -> vec3f {
  let toP = worldPos - frame.camPos;
  let dist = length(toP);
  let dir = toP / max(dist, 1e-4);
  let T = waterTransmittance(dist);
  let ymid = mix(frame.camPos.y, worldPos.y, 0.5);
  return color * T + inscatterColor(ymid, dir) * (1.0 - T);
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
  sky += frame.sunColor * (pow(mu, 1500.0) * 60.0 + pow(mu, 60.0) * 1.2 + pow(mu, 6.0) * 0.25);
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
  // Distant surface looks flatter (normals average out).
  let fade = 1.0 / (1.0 + t * 0.04);
  let g = (w0.grad * 2.2 + (transpose(rot) * w1.grad) * 1.4) * fade;
  let n = normalize(vec3f(-g.x, -1.0, -g.y)); // facing down, toward the viewer

  let cosI = clamp(dot(-dir, n), 0.0, 1.0);
  let refr = refract(dir, n, 1.333);
  let reflected = inscatterColor(frame.surfaceY - 6.0, reflect(dir, n)) * 0.9;
  if (dot(refr, refr) < 1e-6) {
    // Total internal reflection outside Snell's window.
    return reflected;
  }
  // Fresnel for water -> air, which reaches 1 at the critical angle.
  let cosT = sqrt(max(1.0 - 1.333 * 1.333 * (1.0 - cosI * cosI), 0.0));
  let rs = (1.333 * cosI - cosT) / (1.333 * cosI + cosT);
  let rp = (cosI - 1.333 * cosT) / (cosI + 1.333 * cosT);
  let F = clamp(0.5 * (rs * rs + rp * rp), 0.0, 1.0);
  return mix(skyRadiance(normalize(refr)), reflected, F);
}
