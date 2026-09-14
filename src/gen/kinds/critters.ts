// Small seafloor life: sea anemones, urchins, starfish and shells.

import {buildMesh, type Patch} from '../meshgen.ts';
import {
  createPropKind,
  quatAxisAngle,
  quatMul,
  quatUpYaw,
  type Instance,
  type Quat,
} from '../../render/props.ts';
import type {Renderer, RenderSystem} from '../../render/renderer.ts';
import type {GenContext} from '../../world/layout.ts';
import {AuxBuilder} from '../tree.ts';
import type {Rng} from '../../core/rng.ts';
import shapes from '../../shaders/shapes.wgsl';
import propsWgsl from '../../shaders/props.wgsl';

export const CritterKind = {
  Anemone: 0,
  Urchin: 1,
  Starfish: 2,
  Shell: 3,
  Scallop: 4,
  Seahorse: 5,
} as const;
type CritterKind = (typeof CritterKind)[keyof typeof CritterKind];

// Patch part ids (p3.z), written to uv.w for the material.
const Part = {
  Column: 0,
  Tentacle: 1,
  Body: 2,
  Spine: 3,
  StarTop: 4,
  StarBottom: 5,
  Spiral: 6,
  ScallopTop: 7,
  ScallopBottom: 8,
  Seahorse: 9,
  SeahorseFin: 10,
} as const;

const surfaceWgsl = /* wgsl */ `
${shapes}

fn anemoneColumn(pat: Patch, uv: vec2f) -> SurfacePoint {
  let R = pat.p0.x;
  let H = pat.p0.y;
  // Profile: flared foot, column, flared oral disc, then the disc surface to the centre.
  var r: f32;
  var h: f32;
  let s = uv.y;
  if (s < 0.75) {
    let t = s / 0.75;
    r = R * (1.15 - 0.3 * sin(t * 3.14159) + 0.25 * smoothstep(0.7, 1.0, t));
    h = t * H;
  } else {
    let t = (s - 0.75) / 0.25;
    r = R * 1.1 * (1.0 - t);
    h = H + sin(t * 3.14159) * R * 0.15 - t * R * 0.1;
  }
  let wrinkle = fbm3(vec3f(uv.x * 12.0, h * 8.0, 0.0), 2) * 0.05 * R;
  var o = sp(lathePoint(r + wrinkle, h, uv.x), vec4f(uv, 0.0, ${Part.Column}));
  o.ao = mix(0.4, 1.0, smoothstep(0.0, 0.5, s));
  return o;
}

fn urchinBody(pat: Patch, uv: vec2f) -> SurfacePoint {
  let theta = uv.x * TAU;
  let phi = uv.y * 3.14159;
  let dir = vec3f(sin(phi) * cos(theta), -cos(phi), -sin(phi) * sin(theta));
  let R = pat.p0.x;
  // Slightly flattened, with five-fold ambulacral grooves.
  var p = dir * R * vec3f(1.0, 0.72, 1.0);
  p *= 1.0 + 0.04 * pow(abs(cos(theta * 2.5)), 8.0) - 0.03 * worley3(dir * 9.0);
  p.y = max(p.y, -R * 0.45);
  var o = sp(p, vec4f(uv, 0.0, ${Part.Body}));
  o.ao = mix(0.35, 1.0, smoothstep(-0.6, 0.4, dir.y));
  return o;
}

fn starfish(pat: Patch, uv: vec2f, top: bool) -> SurfacePoint {
  let R = pat.p0.x;
  let arms = pat.p0.y;
  let inner = pat.p0.z;
  let thick = pat.p0.w;
  let theta = uv.x * TAU;
  let armShape = pow(abs(cos(arms * theta * 0.5)), pat.p1.x);
  let edge = R * (inner + (1.0 - inner) * armShape) * (1.0 + 0.06 * fbm2(vec2f(theta * 3.0, 0.0), 2));
  let r = uv.y * edge;
  var y = thick * pow(max(1.0 - uv.y * uv.y, 0.0), 0.6) * (0.55 + 0.45 * armShape);
  // Arm tips curl up a little.
  y += pat.p1.y * pow(uv.y, 3.0) * armShape;
  let planar = vec2f(cos(theta), sin(theta)) * r;
  var p: vec3f;
  if (top) {
    let bumps = smoothstep(0.35, 0.0, worley2p(planar * pat.p1.z, vec2i(0)).x) * 0.012 * (1.0 - uv.y * 0.5);
    p = vec3f(planar.x, y + bumps + 0.01, planar.y);
  } else {
    p = vec3f(planar.x, pat.p1.y * pow(uv.y, 3.0) * armShape * 0.9, -planar.y);
  }
  let part = select(${Part.StarBottom}, ${Part.StarTop}, top);
  var o = sp(p, vec4f(uv, armShape, f32(part)));
  o.ao = select(0.4, mix(0.7, 1.0, uv.y), top);
  return o;
}

fn spiralShell(pat: Patch, uv: vec2f) -> SurfacePoint {
  let turns = pat.p0.x;
  let k = pat.p0.y; // expansion per radian
  let S = pat.p0.z; // aperture size relative to radius
  let T = pat.p0.w; // translation along the axis
  let thetaMax = turns * TAU;
  let theta = uv.y * thetaMax;
  let phi = uv.x * TAU;
  let r = exp(k * (theta - thetaMax));
  let radial = vec3f(cos(theta), 0.0, sin(theta));
  let center = radial * r - vec3f(0.0, T * r, 0.0);
  var a = r * S;
  // Growth ribs along the coil and fine spiral cords around the whorl.
  a *= 1.0 + pat.p1.x * pow(abs(sin(theta * pat.p1.y)), 8.0) + 0.015 * sin(phi * 18.0);
  // Knobs on the shoulder.
  a *= 1.0 + pat.p1.z * pow(max(sin(phi - 0.6), 0.0), 6.0) * pow(abs(sin(theta * pat.p1.w)), 4.0);
  let aperture = vec3f(0.0, 1.0, 0.0) * sin(phi) + radial * cos(phi);
  let p = (center + aperture * a) * pat.p2.x;
  var o = sp(p, vec4f(uv, theta / thetaMax, ${Part.Spiral}));
  o.ao = mix(0.5, 1.0, smoothstep(0.0, 0.3, uv.y)) * mix(0.6, 1.0, max(cos(phi), 0.0));
  return o;
}

fn scallop(pat: Patch, uv: vec2f, top: bool) -> SurfacePoint {
  let R = pat.p0.x;
  let spread = pat.p0.y;
  let ribs = pat.p0.z;
  let alpha = (uv.x - 0.5) * spread;
  let r = uv.y * R * (1.0 - 0.1 * pow(abs(uv.x - 0.5) * 2.0, 3.0));
  let rib = pow(abs(sin(alpha * ribs)), 1.5) * 0.02 * R * uv.y;
  let cup = pat.p0.w * sin(uv.y * 3.14159 * 0.9) * (1.0 - pow(abs(uv.x - 0.5) * 2.0, 2.0) * 0.5);
  let s = select(-1.0, 1.0, top);
  let p = vec3f(sin(alpha) * r, (cup + rib) * s + 0.01, cos(alpha) * r - R * 0.5);
  var o = sp(select(vec3f(-p.x, p.y, p.z), p, top), vec4f(uv, rib, f32(select(${Part.ScallopBottom}, ${Part.ScallopTop}, top))));
  o.ao = mix(0.6, 1.0, uv.y);
  return o;
}

fn surface(pat: Patch, uv: vec2f) -> SurfacePoint {
  switch (u32(pat.p3.z)) {
    case ${Part.Column}u: { return anemoneColumn(pat, uv); }
    case ${Part.Tentacle}u: {
      var o = chainTube(u32(pat.p0.x), u32(pat.p0.y), uv, 0.12);
      o.uv = vec4f(uv.x, uv.y, pat.p0.z, ${Part.Tentacle});
      o.ao = mix(0.5, 1.0, uv.y);
      return o;
    }
    case ${Part.Body}u: { return urchinBody(pat, uv); }
    case ${Part.Spine}u: {
      var o = chainTube(u32(pat.p0.x), u32(pat.p0.y), uv, 0.02);
      o.uv = vec4f(uv.x, uv.y, pat.p0.z, ${Part.Spine});
      o.ao = mix(0.4, 1.0, uv.y);
      return o;
    }
    case ${Part.StarTop}u: { return starfish(pat, uv, true); }
    case ${Part.StarBottom}u: { return starfish(pat, uv, false); }
    case ${Part.Spiral}u: { return spiralShell(pat, uv); }
    case ${Part.ScallopTop}u: { return scallop(pat, uv, true); }
    case ${Part.Seahorse}u: {
      var o = chainTube(u32(pat.p0.x), u32(pat.p0.y), uv, 0.02);
      // Bony rings along the body.
      let rings = pow(abs(sin(uv.y * pat.p0.z * 3.14159)), 6.0);
      o.pos += o.normal * rings * 0.004;
      o.normal = vec3f(0.0);
      o.uv = vec4f(uv.x, uv.y, rings, ${Part.Seahorse});
      o.ao = mix(0.6, 1.0, rings);
      return o;
    }
    case ${Part.SeahorseFin}u: {
      let p = vec3f(0.0, pat.p0.y + uv.x * 0.05, pat.p0.z - uv.y * 0.035 * sin(uv.x * 3.14159));
      return sp(p, vec4f(uv, 0.0, ${Part.SeahorseFin}));
    }
    case ${Part.ScallopBottom}u: { return scallop(pat, uv, false); }
    default: { return scallop(pat, uv, false); }
  }
}
`;

const materialWgsl = /* wgsl */ `
${propsWgsl}

fn deform(p: vec3f, n: vec3f, uv: vec4f, inst: Instance, t: f32) -> Deformed {
  let part = u32(uv.w + 0.5);
  if (part == ${Part.Tentacle}u) {
    let along = uv.y;
    let id = uv.z;
    let wiggle = vec3f(sin(t * 1.9 + id * 17.0), 0.0, cos(t * 1.6 + id * 23.0)) * along * along * 0.035;
    let sway = currentSway(inst.posScale.xyz, along, t, 0.05, inst.params.x);
    let pulse = normalize(vec3f(p.x, 0.0, p.z) + 1e-4) * sin(t * 0.7 + inst.params.x) * along * 0.015;
    return Deformed(p + (wiggle + sway + pulse) / max(inst.posScale.w, 0.2), n);
  }
  if (part == ${Part.SeahorseFin}u) {
    return Deformed(p + vec3f(sin(t * 18.0 + uv.x * 6.0) * uv.y * 0.006, 0.0, 0.0), n);
  }
  if (part == ${Part.Seahorse}u || part == ${Part.SeahorseFin}u) {
    return Deformed(p, n);
  }
  if (part == ${Part.Spine}u) {
    let wob = vec3f(sin(t * 0.8 + uv.z * 31.0), 0.0, cos(t * 0.7 + uv.z * 19.0)) * uv.y * uv.y * 0.012;
    return Deformed(p + wob, n);
  }
  return Deformed(p, n);
}

fn material(i: VOut, nIn: vec3f, inst: Instance) -> Surface {
  let part = u32(i.uv.w + 0.5);
  let tint = inst.color.rgb;
  let accent = palette(inst.color.a, vec3f(0.6), vec3f(0.4), vec3f(1.0), vec3f(0.0, 0.33, 0.67));
  let V = normalize(frame.camPos - i.world);
  var s = defaultSurface();
  s.normal = nIn;
  s.ao = i.aoMat.x;
  s.roughness = 0.6;

  switch (part) {
    case ${Part.Column}u: {
      let stripes = 0.5 + 0.5 * sin(i.uv.x * 6.2831853 * 14.0);
      s.albedo = mix(tint * 0.45, tint * 0.75, stripes * smoothstep(0.1, 0.7, i.uv.y));
      s.translucency = 0.3;
    }
    case ${Part.Tentacle}u: {
      let tip = smoothstep(0.7, 1.0, i.uv.y);
      s.albedo = mix(tint, accent, tip * 0.8);
      s.translucency = 0.7;
      s.roughness = 0.4;
      s.emissive = accent * tip * tip * inst.params.y * 0.6;
    }
    case ${Part.Body}u: {
      s.albedo = tint * 0.25;
      s.roughness = 0.5;
    }
    case ${Part.Spine}u: {
      let sheen = pow(1.0 - max(dot(nIn, V), 0.0), 3.0);
      s.albedo = mix(tint * 0.2, tint * 0.5, i.uv.y);
      s.emissive = accent * sheen * 0.04 * inst.params.y;
      s.roughness = 0.3;
      s.f0 = 0.05;
    }
    case ${Part.StarTop}u, ${Part.StarBottom}u: {
      let lp = i.local * inst.posScale.w * 30.0;
      let dots = smoothstep(0.3, 0.12, worley2p(lp.xz, vec2i(0)).x);
      let top = part == ${Part.StarTop}u;
      var c = tint * (0.75 + 0.25 * i.uv.z);
      c = mix(c, accent, dots * 0.55);
      s.albedo = select(tint * vec3f(1.0, 0.85, 0.7) * 0.6, c, top);
      s.normal = bumpNormal(nIn, vec3f(0.0, dots * 0.2, 0.0));
      s.roughness = 0.8;
      s.translucency = 0.1;
    }
    case ${Part.Spiral}u: {
      let along = i.uv.z;
      let bands = smoothstep(0.3, 0.7, sin(along * inst.params.z + fbm2(i.uv.xy * vec2f(6.0, 30.0), 2) * 2.0) * 0.5 + 0.5);
      let flames = smoothstep(0.55, 0.8, sin(i.uv.x * 6.2831853 * 3.0 + along * 40.0) * 0.5 + 0.5);
      var c = mix(tint, tint * 0.35 + accent * 0.2, bands);
      c = mix(c, vec3f(0.95, 0.9, 0.82), flames * 0.4);
      // Glossy porcelain outside, pearly inside the aperture.
      let inside = smoothstep(0.93, 1.0, along) * step(0.5, fract(i.uv.x + 0.25));
      let nacre = palette(dot(nIn, V) * 1.5, vec3f(0.8), vec3f(0.2), vec3f(1.0), vec3f(0.0, 0.1, 0.2));
      s.albedo = mix(c, nacre, inside);
      s.roughness = mix(0.25, 0.15, inside);
      s.f0 = 0.05;
    }
    case ${Part.Seahorse}u: {
      let spots = smoothstep(0.3, 0.1, worley2p(i.uv.xy * vec2f(8.0, 60.0), vec2i(0)).x);
      s.albedo = mix(tint, tint * 0.4, i.uv.z * 0.6) * (1.0 - spots * 0.35);
      s.roughness = 0.5;
      s.translucency = 0.15;
    }
    case ${Part.SeahorseFin}u: {
      s.albedo = tint * 1.1;
      s.translucency = 0.8;
      s.roughness = 0.4;
    }
    default: {
      let rib = smoothstep(0.0, 0.02, i.uv.z);
      let bands = 0.5 + 0.5 * sin(i.uv.y * 40.0);
      let top = part == ${Part.ScallopTop}u;
      let c = mix(tint * 0.6, mix(tint, accent, 0.4), bands * 0.6 + rib * 0.3);
      let nacre = palette(dot(nIn, V) * 1.2 + 0.2, vec3f(0.85), vec3f(0.15), vec3f(1.0), vec3f(0.0, 0.1, 0.2));
      s.albedo = select(nacre, c, top == (dot(nIn, vec3f(0.0, 1.0, 0.0)) >= -0.2));
      s.roughness = 0.35;
      s.f0 = 0.045;
    }
  }
  return s;
}
`;

interface Variant {
  patches: Patch[];
  radius: number;
  kind: CritterKind;
}

const P = (
  params: number[],
  part: number,
  segU: number,
  segV: number,
): Patch => {
  const p = new Array(16).fill(0);
  params.forEach((v, i) => (p[i] = v));
  p[14] = part;
  return {segU, segV, params: p};
};

function anemone(rng: Rng, aux: AuxBuilder, hi: boolean): Variant {
  const R = rng.range(0.08, 0.14);
  const H = rng.range(0.08, 0.2);
  const patches: Patch[] = [P([R, H], Part.Column, hi ? 32 : 16, hi ? 16 : 8)];
  const rings = rng.int(2, 4);
  const count = hi ? rng.int(70, 110) : rng.int(35, 50);
  const len = rng.range(0.12, 0.28);
  for (let i = 0; i < count; i++) {
    const ring = i % rings;
    const a =
      (i / count) * Math.PI * 2 * rings + ring * 0.7 + rng.range(-0.05, 0.05);
    const rr = R * (1.05 - ring * 0.22);
    const dir = [Math.cos(a), 0, -Math.sin(a)];
    const l = len * rng.range(0.8, 1.2) * (1 - ring * 0.12);
    const out = rng.range(0.4, 0.9);
    // Tentacles curl: a sideways wander and a droop that grows toward the tip.
    const curlA = rng.range(-1, 1);
    const droop = rng.range(0.1, 0.45);
    const side = [-dir[2], 0, dir[0]];
    const thick = rng.range(0.013, 0.02) * (hi ? 1 : 1.25);
    const pts: [number, number, number, number][] = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const rad = rr + l * out * t;
      const y = H + 0.01 + l * (1 - out * 0.5) * t - l * droop * t * t * out;
      const curl = Math.sin(t * 2.2) * curlA * l * 0.25;
      pts.push([
        dir[0] * rad + side[0] * curl,
        y,
        dir[2] * rad + side[2] * curl,
        // Fat and fleshy, only slightly tapered, with a bulb at the tip.
        thick * (1 - t * 0.35 + Math.max(0, t - 0.8) * 1.2),
      ]);
    }
    const c = aux.addChain(pts);
    patches.push(
      P(
        [c.offset, c.count, rng.float()],
        Part.Tentacle,
        hi ? 5 : 3,
        hi ? 8 : 5,
      ),
    );
  }
  return {patches, radius: R + len, kind: CritterKind.Anemone};
}

function urchin(rng: Rng, aux: AuxBuilder, hi: boolean): Variant {
  const R = rng.range(0.05, 0.09);
  const long = rng.bool(0.6);
  const spineLen = long ? R * rng.range(2.5, 4.5) : R * rng.range(0.6, 1.2);
  const patches: Patch[] = [P([R], Part.Body, hi ? 24 : 12, hi ? 16 : 8)];
  const count = hi ? 160 : 70;
  for (let i = 0; i < count; i++) {
    // Fibonacci sphere, upper 80%.
    const y = 1 - ((i + 0.5) / count) * 1.6;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * 2.39996;
    const d = [Math.cos(a) * rr, y * 0.72, Math.sin(a) * rr];
    const l =
      spineLen * rng.range(0.7, 1.1) * (0.6 + 0.4 * Math.max(0, y + 0.3));
    const base = [d[0] * R, d[1] * R, d[2] * R];
    const c = aux.addChain([
      [base[0], base[1], base[2], long ? 0.004 : 0.008],
      [base[0] + d[0] * l, base[1] + d[1] * l, base[2] + d[2] * l, 0.0006],
    ]);
    patches.push(P([c.offset, c.count, rng.float()], Part.Spine, 4, 2));
  }
  return {patches, radius: R + spineLen, kind: CritterKind.Urchin};
}

function star(rng: Rng, hi: boolean): Variant {
  const R = rng.range(0.1, 0.2);
  const arms = rng.weighted([5, 6, 7], [8, 1, 1]);
  const params = [
    R,
    arms,
    rng.range(0.2, 0.35),
    R * rng.range(0.12, 0.2),
    rng.range(1.5, 3),
    rng.range(0, 0.02),
    rng.range(80, 140),
  ];
  return {
    patches: [
      P(params, Part.StarTop, hi ? 120 : 60, hi ? 14 : 8),
      P(params, Part.StarBottom, hi ? 60 : 30, 4),
    ],
    radius: R,
    kind: CritterKind.Starfish,
  };
}

function shell(rng: Rng, hi: boolean, scallopShape: boolean): Variant {
  if (scallopShape) {
    const params = [
      rng.range(0.05, 0.09),
      rng.range(2.4, 3.2),
      rng.range(12, 22),
      rng.range(0.008, 0.02),
    ];
    return {
      patches: [
        P(params, Part.ScallopTop, hi ? 32 : 16, hi ? 12 : 6),
        P(params, Part.ScallopBottom, hi ? 32 : 16, hi ? 12 : 6),
      ],
      radius: params[0],
      kind: CritterKind.Scallop,
    };
  }
  const conch = rng.bool(0.5);
  const params = [
    rng.range(3.5, 6), // turns
    rng.range(0.09, 0.16), // expansion
    conch ? rng.range(0.55, 0.75) : rng.range(0.4, 0.6),
    conch ? rng.range(1.5, 3) : rng.range(0.4, 1.2),
    rng.range(0.0, 0.08),
    rng.range(8, 20),
    conch ? rng.range(0.1, 0.3) : 0,
    rng.range(2, 5),
    rng.range(0.03, 0.06), // size
  ];
  return {
    patches: [P(params, Part.Spiral, hi ? 32 : 16, hi ? 96 : 48)],
    radius: 0.1,
    kind: CritterKind.Shell,
  };
}

function seahorse(rng: Rng, aux: AuxBuilder, hi: boolean): Variant {
  const pts: [number, number, number, number][] = [];
  // Curled tail: a tightening spiral in the y/z plane.
  const turns = rng.range(1.1, 1.6);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const a = (1 - t) * turns * Math.PI * 2;
    const r = 0.012 + t * 0.035;
    pts.push([
      0,
      0.04 + Math.sin(a) * r,
      -0.01 + Math.cos(a) * r - t * 0.02,
      0.003 + t * 0.008,
    ]);
  }
  // Body curving up with a pot belly, then the neck.
  const body: [number, number, number][] = [
    [0, 0.09, -0.02],
    [0, 0.14, 0.01],
    [0, 0.2, 0.025],
    [0, 0.26, 0.01],
    [0, 0.3, -0.01],
  ];
  const radii = [0.013, 0.02, 0.022, 0.016, 0.012];
  body.forEach((p, i) => pts.push([...p, radii[i]]));
  // Head bends forward into the long snout.
  pts.push(
    [0, 0.325, 0.005, 0.016],
    [0, 0.33, 0.035, 0.009],
    [0, 0.325, 0.07, 0.005],
    [0, 0.322, 0.085, 0.004],
  );
  const chain = aux.addChain(pts);
  const params = new Array(16).fill(0);
  params[0] = chain.offset;
  params[1] = chain.count;
  params[2] = rng.int(28, 40);
  params[14] = Part.Seahorse;
  const fin = new Array(16).fill(0);
  fin[1] = 0.17;
  fin[2] = -0.03;
  fin[14] = Part.SeahorseFin;
  return {
    patches: [
      {segU: hi ? 10 : 6, segV: hi ? 80 : 40, params},
      {segU: 6, segV: 3, params: fin},
    ],
    radius: 0.2,
    kind: CritterKind.Seahorse,
  };
}

export async function createCritters(
  renderer: Renderer,
  ctx: GenContext,
): Promise<RenderSystem> {
  const rng = ctx.rng('critters');
  const hi = ctx.quality.tierIndex >= 2;
  const aux = new AuxBuilder();
  const variants: Variant[] = [];
  const byKind = new Map<CritterKind, number[]>();
  const add = (v: Variant) => {
    byKind.set(v.kind, [...(byKind.get(v.kind) ?? []), variants.length]);
    variants.push(v);
  };
  for (let i = 0; i < 4; i++) add(anemone(rng, aux, hi));
  for (let i = 0; i < 3; i++) add(urchin(rng, aux, hi));
  for (let i = 0; i < 4; i++) add(star(rng, hi));
  for (let i = 0; i < 6; i++) add(shell(rng, hi, i < 2));
  for (let i = 0; i < 2; i++) add(seahorse(rng, aux, hi));
  const mesh = await buildMesh(
    renderer.device,
    'critters',
    surfaceWgsl,
    variants,
    rng.nextU32(),
    aux.build(),
  );

  const anemoneColors: [number, number, number][] = [
    [0.85, 0.35, 0.6],
    [0.45, 0.8, 0.35],
    [0.9, 0.55, 0.25],
    [0.6, 0.4, 0.9],
    [0.95, 0.85, 0.6],
  ];
  const starColors: [number, number, number][] = [
    [0.95, 0.4, 0.12],
    [0.85, 0.15, 0.15],
    [0.3, 0.45, 0.9],
    [0.75, 0.3, 0.6],
    [0.95, 0.75, 0.3],
  ];
  const urchinColors: [number, number, number][] = [
    [0.35, 0.12, 0.45],
    [0.15, 0.1, 0.12],
    [0.6, 0.12, 0.12],
  ];
  const shellColors: [number, number, number][] = [
    [0.9, 0.75, 0.55],
    [0.85, 0.5, 0.35],
    [0.95, 0.9, 0.8],
    [0.7, 0.45, 0.55],
    [0.6, 0.5, 0.35],
  ];

  const instances: Instance[] = [];
  const place = (
    kind: CritterKind,
    x: number,
    z: number,
    scale: number,
    colors: [number, number, number][],
    rot?: Quat,
    lift = 0,
  ) => {
    const n = ctx.terrain.normalAt(x, z);
    const c = rng.pick(colors);
    instances.push({
      pos: [x, ctx.surfaceTop(x, z) + lift * scale, z],
      scale,
      rot: rot ?? quatUpYaw([n[0], 1, n[2]], rng.range(0, Math.PI * 2)),
      color: [c[0], c[1], c[2], rng.float()],
      params: [
        rng.range(0, 100),
        rng.bool(0.5) ? rng.range(0.3, 1) : 0,
        rng.range(20, 60),
        kind,
      ],
      variant: rng.pick(byKind.get(kind)!),
    });
  };
  const near = (cx: number, cz: number, r: number) => {
    const a = rng.range(0, Math.PI * 2);
    const d = Math.sqrt(rng.float()) * r;
    return [cx + Math.cos(a) * d, cz + Math.sin(a) * d] as const;
  };

  for (const c of ctx.clusters) {
    const k = c.rank === 0 ? 2 : 1;
    // Anemone beds.
    for (let g = 0; g < k; g++) {
      const [gx, gz] = near(c.x, c.z, c.radius * 0.9);
      const count = ctx.count(rng.int(2, 6));
      for (let i = 0; i < count; i++) {
        const [x, z] = near(gx, gz, 0.6);
        place(CritterKind.Anemone, x, z, rng.range(0.9, 2.2), anemoneColors);
      }
      ctx.anemones.push([gx, ctx.surfaceTop(gx, gz) + 0.25, gz]);
    }
    for (let i = 0; i < ctx.count(rng.int(3, 8) * k); i++) {
      const [x, z] = near(c.x, c.z, c.radius * 1.3);
      place(CritterKind.Urchin, x, z, rng.range(0.8, 1.6), urchinColors);
    }
    for (let i = 0; i < ctx.count(rng.int(1, 3) * k); i++) {
      const [x, z] = near(c.x, c.z, c.radius * 1.4);
      place(CritterKind.Starfish, x, z, rng.range(0.8, 1.5), starColors);
    }
  }

  // Shells and starfish scattered over the sand.
  const center = ctx.nav.o.center;
  const R = ctx.desc.terrain.basinRadius;
  for (let i = 0; i < ctx.count(120); i++) {
    const [x, z] = near(center[0], center[1], R);
    if (ctx.terrain.maskAt(0, x, z) > 0.5) {
      continue;
    }
    const roll = rng.float();
    if (roll < 0.25) {
      place(CritterKind.Starfish, x, z, rng.range(0.7, 1.3), starColors);
    } else if (roll < 0.5) {
      place(CritterKind.Scallop, x, z, rng.range(0.7, 1.3), shellColors);
    } else {
      // Spiral shells lie on their side at a random angle.
      const yaw = quatAxisAngle([0, 1, 0], rng.range(0, Math.PI * 2));
      const tip = quatAxisAngle([1, 0, 0], rng.range(1.2, 1.9));
      place(
        CritterKind.Shell,
        x,
        z,
        rng.range(0.7, 1.4),
        shellColors,
        quatMul(yaw, tip),
        0.03,
      );
    }
  }
  // Seahorses clinging near reef edges, tail anchored, body upright.
  const seahorseColors: [number, number, number][] = [
    [0.95, 0.75, 0.2],
    [0.9, 0.45, 0.15],
    [0.55, 0.3, 0.6],
    [0.6, 0.5, 0.35],
  ];
  for (const c of ctx.clusters) {
    const n = ctx.count(rng.int(0, 3));
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = c.radius * rng.range(0.7, 1.2);
      place(
        CritterKind.Seahorse,
        c.x + Math.cos(a) * r,
        c.z + Math.sin(a) * r,
        rng.range(0.8, 1.2),
        seahorseColors,
        undefined,
        0.05,
      );
    }
  }

  for (let i = 0; i < ctx.count(40); i++) {
    const [x, z] = near(center[0], center[1], R);
    if (ctx.terrain.maskAt(0, x, z) < 0.3) {
      continue;
    }
    place(CritterKind.Urchin, x, z, rng.range(0.8, 1.4), urchinColors);
  }

  return createPropKind(renderer, {
    name: 'critters',
    mesh,
    instances,
    wgsl: materialWgsl,
    castShadows: true,
  });
}
