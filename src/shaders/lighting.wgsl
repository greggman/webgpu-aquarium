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
