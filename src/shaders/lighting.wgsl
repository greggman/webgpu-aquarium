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
  // Deeper points see blurrier caustics (the focal lines spread out).
  let lod = clamp(log2(1.0 + depth * 0.12), 0.0, 5.0);
  let c = textureSampleLevel(tCaustics, sLinearRepeat, uv, lod).rgb;
  let fade = frame.caustics.y * exp(-depth / frame.caustics.z);
  let facing = smoothstep(0.0, 0.5, normal.y);
  return mix(vec3f(1.0), c, fade * facing);
}

/** Full lighting for a surface point. Returns radiance before water fog. */
fn shadeSurface(s: Surface, p: vec3f, shadowOverride: f32) -> vec3f {
  let V = normalize(frame.camPos - p);
  let N = s.normal;
  let L = frame.sunDir;
  let H = normalize(V + L);
  let NoV = max(dot(N, V), 1e-4);
  let NoLraw = dot(N, L);
  let NoL = max(NoLraw, 0.0);
  let NoH = max(dot(N, H), 0.0);
  let VoH = max(dot(V, H), 0.0);

  var shadow = shadowOverride;
  if (shadow < 0.0) {
    shadow = sunShadow(p, N);
  }
  let sun = sunAtDepth(p.y) * shadow * causticsAt(p, N);

  let a = max(s.roughness * s.roughness, 0.002);
  let f0 = mix(vec3f(s.f0), s.albedo, s.metallic);
  let F = F_Schlick(VoH, f0);
  let spec = D_GGX(NoH, a) * V_SmithGGXCorrelated(NoV, NoL, a) * F;
  let kd = (vec3f(1.0) - F) * (1.0 - s.metallic);

  // Wrapped diffuse for translucent things so light bleeds around the edge.
  let wrap = s.translucency * 0.5;
  let diffuseNoL = max((NoLraw + wrap) / ((1.0 + wrap) * (1.0 + wrap)), 0.0);
  var color = (kd * s.albedo / PI * diffuseNoL + spec * NoL) * sun;

  // Light passing through thin tissue toward the viewer.
  let backlit = pow(max(dot(-V, L), 0.0), 3.0) * 0.7 + max(-NoLraw, 0.0) * 0.3;
  color += s.albedo * s.translucency * backlit * sun * 0.6;

  // Ambient: bright blue from above, dim bounce from below.
  let amb = ambientAtDepth(p.y);
  let bounce = sunAtDepth(p.y) * vec3f(0.32, 0.30, 0.24) * 0.12;
  let hemi = mix(bounce, amb, N.y * 0.5 + 0.5);
  color += kd * s.albedo * hemi * s.ao;

  // Specular ambient: water colour reflected at grazing angles.
  let R = reflect(-V, N);
  let Fa = F_Schlick(NoV, f0) * (1.0 - s.roughness * 0.7);
  color += Fa * inscatterColor(p.y, R) * s.ao * 0.6;

  return color + s.emissive;
}
