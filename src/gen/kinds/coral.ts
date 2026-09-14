// Hard and soft coral: branching (staghorn / finger), brain coral, table
// coral, barrel and tube sponges, and swaying sea whips. All share one mesh
// build and one pipeline; the kind lives in patch/instance parameters.

import {buildMesh, type Patch} from '../meshgen.ts';
import {createPropKind, quatUpYaw, type Instance} from '../../render/props.ts';
import type {Renderer, RenderSystem} from '../../render/renderer.ts';
import type {GenContext} from '../../world/layout.ts';
import {AuxBuilder, chainsRadius, growTree} from '../tree.ts';
import type {Rng} from '../../core/rng.ts';
import shapes from '../../shaders/shapes.wgsl';
import propsWgsl from '../../shaders/props.wgsl';

export const CoralKind = {
  Branching: 0,
  Brain: 1,
  Table: 2,
  Sponge: 3,
  Whip: 4,
} as const;
export type CoralKind = (typeof CoralKind)[keyof typeof CoralKind];

const surfaceWgsl = /* wgsl */ `
${shapes}

fn branchSurface(pat: Patch, uv: vec2f) -> SurfacePoint {
  var o = chainTube(u32(pat.p0.x), u32(pat.p0.y), uv, pat.p0.z);
  // Polyp texture: small cells pressed into the surface.
  let cells = worley3(o.pos * pat.p1.x);
  let bump = (smoothstep(0.0, 0.45, cells) - 0.5) * pat.p1.y;
  let fade = smoothstep(0.0, 0.06, uv.y);
  o.pos += o.normal * bump * fade;
  o.normal = vec3f(0.0);
  o.uv = vec4f(uv.x, uv.y, pat.p0.w, cells);
  o.ao = mix(0.45, 1.0, clamp(uv.y * 0.6 + pat.p0.w * 0.6, 0.0, 1.0));
  o.mat = f32(${CoralKind.Branching});
  return o;
}

fn brainSurface(pat: Patch, uv: vec2f) -> SurfacePoint {
  let theta = uv.x * TAU;
  let e = uv.y * 1.5707963;
  let dir = vec3f(cos(e) * cos(theta), sin(e), -cos(e) * sin(theta));
  var p = dir * pat.p0.xyz;
  let q = dir * pat.p1.x + pat.p2.xyz;
  // Meandering labyrinth: level lines of warped noise become ridges.
  let field = fbm3(q, 4) * pat.p1.y + fbm3(q * 2.3, 2) * 1.5;
  let ridge = pow(1.0 - abs(sin(field)), 2.5);
  let rim = smoothstep(0.0, 0.25, uv.y);
  p += dir * (ridge * pat.p1.z * rim + fbm3(q * 0.7, 2) * 0.08);
  // Slight flare and sink at the base.
  p.y -= (1.0 - rim) * 0.1 * pat.p0.y;
  var o = sp(p, vec4f(uv, ridge, 0.0));
  o.ao = mix(0.35, 1.0, ridge) * mix(0.5, 1.0, rim);
  o.mat = f32(${CoralKind.Brain});
  return o;
}

fn tableSurface(pat: Patch, uv: vec2f) -> SurfacePoint {
  let part = u32(pat.p2.w);
  if (part == 2u) {
    var o = chainTube(u32(pat.p0.x), u32(pat.p0.y), uv, 0.0);
    o.mat = f32(${CoralKind.Table});
    o.ao = 0.5;
    o.uv.w = 0.0;
    return o;
  }
  let R = pat.p1.x;
  let theta = uv.x * TAU;
  let r = uv.y * R;
  let lobes = pat.p1.y;
  let edge = pow(uv.y, 3.0);
  let wave = sin(theta * lobes + fbm2(vec2f(theta * 2.0, 1.0), 2) * 2.0) * pat.p1.z * edge;
  let dome = pat.p2.x * (1.0 - uv.y * uv.y) + pat.p2.y * uv.y;
  let thick = pat.p1.w * (1.0 - pow(uv.y, 10.0));
  let rr = r * (1.0 + 0.04 * sin(theta * 3.0 + 1.7) * edge + 0.03 * fbm2(vec2f(theta * 4.0, 3.0), 2) * edge);
  let rough = fbm3(vec3f(cos(theta) * rr, 0.0, sin(theta) * rr) * 3.0, 3) * 0.04;
  var y = pat.p0.z + dome + wave + rough;
  var s = 1.0;
  if (part == 0u) {
    y += thick;
  } else {
    s = -1.0;
  }
  let pos = vec3f(cos(theta) * rr + pat.p0.x, y, s * sin(theta) * rr + pat.p0.y);
  var o = sp(pos, vec4f(uv, f32(part), 0.0));
  o.ao = select(mix(0.55, 0.8, uv.y), mix(0.7, 1.0, uv.y), part == 0u);
  o.mat = f32(${CoralKind.Table});
  return o;
}

fn spongeProfile(s: f32, r0: f32, r1: f32, h: f32, wall: f32, bulge: f32) -> vec3f {
  // Returns (radius, height, inside flag) along the outside-lip-inside profile.
  if (s < 0.62) {
    let t = s / 0.62;
    return vec3f(mix(r0, r1, t) + bulge * sin(3.14159 * t), t * h, 0.0);
  }
  if (s < 0.72) {
    let t = (s - 0.62) / 0.1;
    let a = t * 3.14159;
    return vec3f(r1 - wall * 0.5 + cos(a) * wall * 0.5, h + sin(a) * wall * 0.5, t);
  }
  let t = (s - 0.72) / 0.28;
  return vec3f(r1 - wall - t * wall * 0.5, h * (1.0 - t * 0.85), 1.0);
}

fn spongeSurface(pat: Patch, uv: vec2f) -> SurfacePoint {
  let theta = uv.x * TAU;
  let ring = vec3f(cos(theta), 0.0, sin(theta));
  // Irregular organic outline: lobed cross-section and a wavy, uneven rim.
  let lobes = 1.0 + fbm3(ring * 1.3 + pat.p2.xyz, 3) * 0.55 + 0.12 * sin(theta * 3.0 + pat.p2.x);
  let rimWave = 1.0 + 0.18 * fbm3(ring * 2.0 + pat.p2.zyx, 2) + 0.08 * sin(theta * 5.0 + pat.p2.y);
  let prof = spongeProfile(uv.y, pat.p0.x * lobes, pat.p0.y * lobes, pat.p0.z * rimWave, pat.p0.w, pat.p1.w);
  var p = lathePoint(prof.x, prof.y, uv.x);
  // Deep pores and knobbly ridges.
  let q = p * pat.p1.x + pat.p2.xyz;
  let pores = worley3(q);
  let knobs = fbm3(q * 0.6, 3);
  let outward = normalize(vec3f(p.x, 0.0, p.z) + vec3f(1e-4));
  p += outward * ((smoothstep(0.05, 0.35, pores) - 1.0) * pat.p1.y * 1.6 + knobs * 0.02) * (1.0 - prof.z);
  p += vec3f(fbm3(q * 0.3, 2), 0.0, fbm3(q * 0.3 + 9.0, 2)) * 0.08 * prof.y;
  // Lean the tube.
  p += vec3f(pat.p2.w, 0.0, pat.p3.x) * prof.y * prof.y / max(pat.p0.z, 0.01);
  p += pat.p3.yzz * vec3f(1.0, 0.0, 0.0) + vec3f(0.0, 0.0, pat.p3.z);
  var o = sp(p, vec4f(uv, prof.z, pores));
  o.ao = mix(1.0, 0.3, prof.z) * mix(0.55, 1.0, smoothstep(0.0, 0.3, pores));
  o.mat = f32(${CoralKind.Sponge});
  return o;
}

fn whipSurface(pat: Patch, uv: vec2f) -> SurfacePoint {
  var o = chainTube(u32(pat.p0.x), u32(pat.p0.y), uv, pat.p0.z);
  o.uv = vec4f(uv.x, uv.y, pat.p0.w, 0.0);
  o.ao = mix(0.6, 1.0, uv.y);
  o.mat = f32(${CoralKind.Whip});
  return o;
}

fn surface(pat: Patch, uv: vec2f) -> SurfacePoint {
  switch (u32(pat.p3.w)) {
    case 1u: { return brainSurface(pat, uv); }
    case 2u: { return tableSurface(pat, uv); }
    case 3u: { return spongeSurface(pat, uv); }
    case 4u: { return whipSurface(pat, uv); }
    default: { return branchSurface(pat, uv); }
  }
}
`;

const materialWgsl = /* wgsl */ `
${propsWgsl}

fn deform(p: vec3f, n: vec3f, uv: vec4f, inst: Instance, t: f32) -> Deformed {
  let kind = u32(inst.params.w);
  if (kind == ${CoralKind.Whip}u || kind == ${CoralKind.Branching}u) {
    let strength = select(0.004, 0.06, kind == ${CoralKind.Whip}u) / max(inst.posScale.w, 0.3);
    let h = max(p.y, 0.0);
    return Deformed(p + currentSway(inst.posScale.xyz, h, t, strength, inst.params.x), n);
  }
  return Deformed(p, n);
}

fn material(i: VOut, nIn: vec3f, inst: Instance) -> Surface {
  let kind = u32(inst.params.w);
  let tint = inst.color.rgb;
  let accent = palette(inst.color.a, vec3f(0.6), vec3f(0.4), vec3f(1.0), vec3f(0.0, 0.33, 0.67));
  let lp = i.local * inst.posScale.w;
  let fine = triplanarDetail(lp + inst.params.x, nIn, 1.4);
  // Polyp cups and corallite texture as a height field (before any branching,
  // so the derivatives stay in uniform control flow).
  let polyps = triplanarDetail(lp * 1.0 + inst.params.x, nIn, 9.0);
  let broad = triplanarDetail(lp, nIn, 0.6);
  let cup = smoothstep(0.02, 0.3, polyps.g);
  let height = cup * 0.6 + fine.a * 0.3 + i.uv.w * 0.4;
  let bumped = bumpFromHeight(nIn, i.world, height, 0.06);
  var s = defaultSurface();
  s.normal = bumped;
  s.ao = i.aoMat.x;
  s.roughness = 0.65;
  s.f0 = 0.03;

  switch (kind) {
    case ${CoralKind.Branching}u: {
      let along = i.uv.y;
      let gen = i.uv.z;
      let tip = smoothstep(0.75, 1.0, along) * (0.4 + 0.6 * gen);
      // Living tissue is richest mid-branch; the base is browner and older,
      // the growing tips pale and slightly see-through.
      let base = mix(tint * vec3f(0.7, 0.6, 0.5), tint, smoothstep(0.0, 0.45, along * 0.8 + gen * 0.4));
      var c = base * mix(0.55, 1.05, clamp(along * 0.7 + gen * 0.5, 0.0, 1.0)) * (0.85 + 0.3 * broad.r);
      c = mix(c, mix(vec3f(0.95, 0.92, 0.85), accent, inst.params.y), tip * 0.75);
      // Polyp cups are darker pits.
      c *= mix(0.6, 1.0, smoothstep(0.05, 0.35, i.uv.w)) * mix(0.8, 1.0, cup);
      s.albedo = c;
      s.roughness = mix(0.8, 0.55, tip);
      s.translucency = mix(0.2, 0.6, tip);
      s.emissive = accent * tip * inst.params.z * 0.25;
    }
    case ${CoralKind.Brain}u: {
      let ridge = i.uv.z;
      let groove = mix(tint * 0.35, accent * 0.4, 0.3);
      s.albedo = mix(groove, tint * (0.85 + 0.3 * fine.r), smoothstep(0.2, 0.8, ridge));
      s.roughness = 0.75;
      s.translucency = 0.1;
    }
    case ${CoralKind.Table}u: {
      let top = i.uv.z < 0.5;
      let rim = smoothstep(0.8, 1.0, i.uv.y);
      // Table corals are muted browns and tans with a paler growing rim.
      let muted = mix(tint, vec3f(0.5, 0.45, 0.36), 0.45);
      // A plate is a mat of fused radial branchlets: streaks that fan out from
      // the centre at roughly constant spacing (more of them further out),
      // broken up by noise, with corallite bumps and irregular dark blotches.
      let fan = i.uv.x * 6.2831853 * mix(12.0, 70.0, i.uv.y) + fine.g * 5.0 + broad.r * 3.0;
      let streak = smoothstep(0.2, 0.9, 0.5 + 0.5 * sin(fan)) * smoothstep(0.05, 0.3, i.uv.y);
      let blotch = smoothstep(0.35, 0.7, broad.r);
      // Underside is shaded and dull; the top has a darker older centre.
      let centre = smoothstep(0.5, 0.0, i.uv.y);
      var c = muted * select(0.38, 1.0, top) * (0.75 + 0.4 * fine.r) * mix(1.0, 0.72, centre);
      c *= mix(0.7, 1.0, streak) * mix(0.62, 1.0, cup) * mix(1.0, 0.75, blotch);
      c = mix(c, mix(muted, vec3f(0.9, 0.86, 0.75), 0.5), rim * 0.5);
      s.albedo = c;
      s.roughness = 0.8;
      s.translucency = 0.2;
    }
    case ${CoralKind.Sponge}u: {
      let inside = i.uv.z;
      let pore = smoothstep(0.05, 0.3, i.uv.w);
      // Fine oscula (small pores) from the detail texture on top of the big ones.
      let micro = smoothstep(0.25, 0.05, polyps.g);
      let spongeTint = mix(tint, vec3f(dot(tint, vec3f(0.33))), 0.3);
      var c = spongeTint * mix(0.12, 1.0, pore) * mix(1.0, 0.3, inside) * (0.75 + 0.35 * fine.r);
      c *= 1.0 - micro * 0.45;
      // Velvety fibres catch light at grazing angles.
      let V = normalize(frame.camPos - i.world);
      let sheen = pow(1.0 - abs(dot(nIn, V)), 3.0);
      s.albedo = c;
      s.emissive = spongeTint * sheen * 0.04 * max(frame.sunColor.g, 1.0) * (1.0 - inside);
      s.roughness = 0.95;
      s.translucency = 0.08;
    }
    default: {
      let along = i.uv.y;
      s.albedo = mix(tint * 0.6, accent, smoothstep(0.5, 1.0, along) * 0.6);
      s.translucency = 0.45;
      s.roughness = 0.55;
    }
  }
  return s;
}
`;

/** Vivid but believable reef colours; each seed picks a subset. */
const CORAL_COLORS: [number, number, number][] = [
  [0.55, 0.22, 0.62], // purple
  [0.85, 0.3, 0.52], // magenta pink
  [0.95, 0.5, 0.18], // orange
  [0.92, 0.78, 0.25], // yellow
  [0.25, 0.62, 0.48], // green
  [0.3, 0.5, 0.88], // blue
  [0.82, 0.2, 0.18], // red
  [0.88, 0.82, 0.66], // cream
  [0.6, 0.45, 0.3], // tan
  [0.35, 0.75, 0.75], // aqua
];

interface VariantInfo {
  patches: Patch[];
  radius: number;
  kind: CoralKind;
  /** Rough height, for placement. */
  height: number;
}

function branchingVariant(
  rng: Rng,
  aux: AuxBuilder,
  style: 'staghorn' | 'finger' | 'bush',
  hi: boolean,
): VariantInfo {
  const opts =
    style === 'staghorn'
      ? {
          radius: 0.06,
          segmentLength: 0.16,
          segmentsPerChain: [5, 9] as [number, number],
          maxDepth: 3,
          branchChance: 0.3,
          branchAngle: [0.4, 0.9] as [number, number],
          wander: 0.25,
          upBias: 0.12,
          outward: 0.12,
          radiusDecay: 0.93,
          childRadius: 0.85,
          minRadius: 0.02,
          maxChains: 48,
          trunks: rng.int(3, 6),
          trunkSpread: 0.9,
        }
      : style === 'finger'
        ? {
            radius: 0.07,
            segmentLength: 0.1,
            segmentsPerChain: [3, 6] as [number, number],
            maxDepth: 2,
            branchChance: 0.35,
            branchAngle: [0.2, 0.5] as [number, number],
            wander: 0.12,
            upBias: 0.35,
            outward: 0.05,
            radiusDecay: 0.97,
            childRadius: 0.9,
            minRadius: 0.035,
            maxChains: 40,
            trunks: rng.int(6, 10),
            trunkSpread: 0.7,
          }
        : {
            radius: 0.045,
            segmentLength: 0.09,
            segmentsPerChain: [3, 5] as [number, number],
            maxDepth: 4,
            branchChance: 0.5,
            branchAngle: [0.35, 0.8] as [number, number],
            wander: 0.3,
            upBias: 0.2,
            outward: 0.08,
            radiusDecay: 0.92,
            childRadius: 0.85,
            minRadius: 0.015,
            maxChains: 70,
            trunks: rng.int(2, 4),
            trunkSpread: 0.6,
          };
  const chains = growTree(rng, opts);
  const patches: Patch[] = chains.map(c => {
    const {offset, count} = aux.addChain(c.points);
    return {
      segU: hi ? 8 : 5,
      segV: Math.max(4, count * (hi ? 3 : 2)),
      params: [
        offset,
        count,
        c.depth === c.maxDepth || c.points.length < 5 ? 0.12 : 0.06,
        c.maxDepth ? c.depth / c.maxDepth : 1,
        rng.range(28, 45),
        0.006,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        CoralKind.Branching,
      ],
    };
  });
  let h = 0;
  chains.forEach(c => c.points.forEach(p => (h = Math.max(h, p[1]))));
  return {
    patches,
    radius: chainsRadius(chains),
    kind: CoralKind.Branching,
    height: h,
  };
}

function whipVariant(rng: Rng, aux: AuxBuilder, hi: boolean): VariantInfo {
  const chains = growTree(rng, {
    radius: 0.025,
    segmentLength: 0.18,
    segmentsPerChain: [6, 12],
    maxDepth: 2,
    branchChance: 0.18,
    branchAngle: [0.25, 0.5],
    wander: 0.1,
    upBias: 0.25,
    outward: 0.03,
    radiusDecay: 0.94,
    childRadius: 0.8,
    minRadius: 0.008,
    maxChains: 16,
    trunks: rng.int(1, 3),
    trunkSpread: 0.5,
  });
  const patches: Patch[] = chains.map(c => {
    const {offset, count} = aux.addChain(c.points);
    return {
      segU: hi ? 6 : 4,
      segV: count * 2,
      params: [
        offset,
        count,
        0.1,
        c.maxDepth ? c.depth / c.maxDepth : 1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        CoralKind.Whip,
      ],
    };
  });
  let h = 0;
  chains.forEach(c => c.points.forEach(p => (h = Math.max(h, p[1]))));
  return {
    patches,
    radius: chainsRadius(chains),
    kind: CoralKind.Whip,
    height: h,
  };
}

function brainVariant(rng: Rng, hi: boolean): VariantInfo {
  const r = rng.range(0.4, 0.7);
  const shape = [
    r * rng.range(0.9, 1.15),
    r * rng.range(0.55, 0.85),
    r * rng.range(0.9, 1.15),
  ];
  return {
    patches: [
      {
        segU: hi ? 128 : 64,
        segV: hi ? 48 : 24,
        params: [
          ...shape,
          0,
          rng.range(2.5, 4),
          rng.range(10, 18),
          rng.range(0.025, 0.045),
          0,
          rng.range(-40, 40),
          rng.range(-40, 40),
          rng.range(-40, 40),
          0,
          0,
          0,
          0,
          CoralKind.Brain,
        ],
      },
    ],
    radius: r * 1.2,
    kind: CoralKind.Brain,
    height: shape[1],
  };
}

function tableVariant(rng: Rng, aux: AuxBuilder, hi: boolean): VariantInfo {
  // Tiered plates on a short stalk: each tier smaller and offset, like
  // layered Acropora tables, with crinkled rather than star-shaped edges.
  const tiers = rng.int(1, 3);
  const baseR = rng.range(0.6, 1.1);
  const stalkH = rng.range(0.2, 0.45);
  const patches: Patch[] = [];
  let top = 0;
  for (let t = 0; t < tiers; t++) {
    const R = baseR * (1 - t * 0.28);
    const h = stalkH + t * rng.range(0.14, 0.24);
    top = h;
    const ox = t ? rng.range(-0.15, 0.15) : 0;
    const oz = t ? rng.range(-0.15, 0.15) : 0;
    const stalk = aux.addChain([
      [ox * 0.3, t ? h - 0.2 : -0.1, oz * 0.3, t ? 0.05 : 0.11],
      [ox * 0.7 + 0.02, h * 0.5 + (t ? h * 0.5 - 0.1 : 0), oz * 0.7, 0.07],
      [ox, h, oz, 0.1],
    ]);
    const lobes = rng.int(6, 11);
    const plate = (part: number): Patch => ({
      segU: hi ? 72 : 36,
      segV: hi ? 16 : 8,
      params: [
        ox,
        oz,
        h,
        0,
        R,
        lobes,
        rng.range(0.012, 0.03),
        0.035,
        rng.range(0.02, 0.07),
        rng.range(-0.04, 0.05),
        0,
        part,
        0,
        0,
        0,
        CoralKind.Table,
      ],
    });
    const topPlate = plate(0);
    const bottomPlate = {...topPlate, params: [...topPlate.params]};
    bottomPlate.params[11] = 1;
    patches.push(topPlate, bottomPlate, {
      segU: 8,
      segV: 6,
      params: [
        stalk.offset,
        stalk.count,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        2,
        0,
        0,
        0,
        CoralKind.Table,
      ],
    });
  }
  return {
    patches,
    radius: baseR * 1.1,
    kind: CoralKind.Table,
    height: top + 0.1,
  };
}

function spongeVariant(rng: Rng, hi: boolean): VariantInfo {
  const tubes = rng.bool(0.1) ? 1 : rng.int(4, 9);
  const patches: Patch[] = [];
  let height = 0;
  for (let t = 0; t < tubes; t++) {
    const barrel = tubes === 1;
    // Tube sponges are slender (height several times the width) and splay
    // outward from a shared base, unlike a cup or vase.
    const h = barrel ? rng.range(0.45, 0.8) : rng.range(0.35, 1.0);
    const r0 = barrel ? rng.range(0.22, 0.34) : rng.range(0.035, 0.07);
    const r1 = barrel ? r0 * rng.range(1.15, 1.35) : r0 * rng.range(0.9, 1.15);
    const a = rng.range(0, Math.PI * 2);
    const off = tubes === 1 ? 0 : rng.range(0.04, 0.16);
    height = Math.max(height, h);
    patches.push({
      segU: hi ? 40 : 20,
      segV: hi ? 28 : 16,
      params: [
        r0,
        r1,
        h,
        barrel ? 0.05 : 0.014,
        rng.range(10, 18),
        barrel ? 0.03 : 0.008,
        rng.range(-30, 30),
        rng.range(0, 0.04),
        rng.range(-30, 30),
        rng.range(-30, 30),
        rng.range(-30, 30),
        barrel ? rng.range(-0.1, 0.1) : Math.cos(a) * rng.range(0.1, 0.35),
        barrel ? rng.range(-0.1, 0.1) : Math.sin(a) * rng.range(0.1, 0.35),
        Math.cos(a) * off,
        Math.sin(a) * off,
        CoralKind.Sponge,
      ],
    });
  }
  return {patches, radius: 0.7, kind: CoralKind.Sponge, height};
}

export async function createCoral(
  renderer: Renderer,
  ctx: GenContext,
): Promise<RenderSystem> {
  const rng = ctx.rng('coral');
  const hi = ctx.quality.tierIndex >= 2;
  const aux = new AuxBuilder();
  const variants: VariantInfo[] = [];
  const byKind = new Map<CoralKind, number[]>();
  const add = (v: VariantInfo) => {
    const list = byKind.get(v.kind) ?? [];
    list.push(variants.length);
    byKind.set(v.kind, list);
    variants.push(v);
  };
  for (const style of [
    'staghorn',
    'staghorn',
    'finger',
    'bush',
    'bush',
    'finger',
  ] as const) {
    add(branchingVariant(rng, aux, style, hi));
  }
  for (let i = 0; i < 4; i++) add(brainVariant(rng, hi));
  for (let i = 0; i < 3; i++) add(tableVariant(rng, aux, hi));
  for (let i = 0; i < 4; i++) add(spongeVariant(rng, hi));
  for (let i = 0; i < 4; i++) add(whipVariant(rng, aux, hi));
  // Low-detail variants for the dense reef carpet: small on screen, so they
  // don't need many vertices.
  const lowKind = new Map<CoralKind, number[]>();
  const addLow = (v: VariantInfo) => {
    lowKind.set(v.kind, [...(lowKind.get(v.kind) ?? []), variants.length]);
    variants.push(v);
  };
  for (const style of ['finger', 'bush', 'staghorn'] as const) {
    addLow(branchingVariant(rng, aux, style, false));
  }
  for (let i = 0; i < 3; i++) addLow(brainVariant(rng, false));
  for (let i = 0; i < 2; i++) addLow(spongeVariant(rng, false));
  for (let i = 0; i < 2; i++) addLow(whipVariant(rng, aux, false));
  addLow(tableVariant(rng, aux, false));

  const mesh = await buildMesh(
    renderer.device,
    'coral',
    surfaceWgsl,
    variants,
    rng.nextU32(),
    aux.build(),
  );

  // Pick this reef's palette.
  const palette = rng.shuffle([...CORAL_COLORS]).slice(0, rng.int(5, 7));
  const color = (): [number, number, number, number] => {
    const c = rng.pick(palette);
    const v = rng.range(0.85, 1.1);
    return [c[0] * v, c[1] * v, c[2] * v, rng.float()];
  };

  const instances: Instance[] = [];
  const place = (
    kind: CoralKind,
    x: number,
    z: number,
    scale: number,
    lean = 0.25,
    low = false,
  ) => {
    const list = (low ? lowKind : byKind).get(kind)!;
    const variant = rng.pick(list);
    const n = ctx.terrain.normalAt(x, z);
    const vi = variants[variant];
    // Massive heads grow up out of the substrate: bury their base (and seat
    // them along the slope) so no dark underside or floating rim shows.
    const massive = kind === CoralKind.Brain || kind === CoralKind.Sponge;
    const table = kind === CoralKind.Table;
    if (massive) {
      lean = Math.max(lean, 0.7);
    }
    const slope = Math.hypot(n[0], n[2]) / Math.max(n[1], 0.2);
    const sink = massive
      ? vi.height * scale * 0.22 + vi.radius * scale * slope * 0.5
      : table
        ? 0.12 * scale + vi.radius * scale * slope * 0.25
        : 0.04 * scale;
    const y = ctx.surfaceTop(x, z) - sink;
    instances.push({
      pos: [x, y, z],
      scale,
      rot: quatUpYaw(
        [
          n[0] * lean + rng.range(-0.1, 0.1),
          1,
          n[2] * lean + rng.range(-0.1, 0.1),
        ],
        rng.range(0, Math.PI * 2),
      ),
      color: color(),
      params: [
        rng.range(0, 100),
        rng.float(),
        rng.bool(0.3) ? rng.range(0.3, 1) : 0,
        kind,
      ],
      variant,
    });
    // Big coral heads are solid to the camera and to fish.
    const v = vi;
    const solid =
      kind === CoralKind.Brain ||
      kind === CoralKind.Table ||
      kind === CoralKind.Sponge;
    if (solid && scale * v.radius > 0.5) {
      ctx.obstacles.push({
        center: [x, y + v.height * scale * 0.5, z],
        radius: v.radius * scale * 0.7,
      });
    }
    return v;
  };

  for (const c of ctx.clusters) {
    const density = c.rank === 0 ? 1.6 : 1;
    const inCluster = (k: number) => {
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.float()) * c.radius * k;
      return [c.x + Math.cos(a) * r, c.z + Math.sin(a) * r] as const;
    };
    // Area-proportional counts so big clusters are as lush as small ones.
    const area = (c.radius * c.radius) / 25;
    for (let i = 0; i < Math.round(rng.int(6, 9) * density * area); i++) {
      const [x, z] = inCluster(0.9);
      place(CoralKind.Brain, x, z, rng.range(0.7, 1.7));
    }
    for (let i = 0; i < ctx.count(rng.int(6, 10) * density * area); i++) {
      const [x, z] = inCluster(1);
      place(CoralKind.Branching, x, z, rng.range(0.55, 1.35));
    }
    for (let i = 0; i < Math.round(rng.int(2, 4) * density * area); i++) {
      const [x, z] = inCluster(0.9);
      place(CoralKind.Table, x, z, rng.range(0.6, 1.15), 0.1);
    }
    for (let i = 0; i < ctx.count(rng.int(3, 6) * density * area); i++) {
      const [x, z] = inCluster(1.1);
      place(CoralKind.Sponge, x, z, rng.range(0.7, 1.6), 0.1);
    }
    for (let i = 0; i < ctx.count(rng.int(5, 10) * density * area); i++) {
      const [x, z] = inCluster(1.2);
      place(CoralKind.Whip, x, z, rng.range(0.45, 1.0), 0.1);
    }
    ctx.occupied.add(c.x, c.z, c.radius * 0.8);
  }

  // Encrust the tops of big rocks with small corals and sponges so the rock
  // reads as reef framework rather than bare stone.
  for (const o of [...ctx.obstacles]) {
    if (o.radius < 1.1) {
      continue;
    }
    const n = ctx.count(Math.round(o.radius * rng.range(2, 4)));
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.float()) * o.radius * 0.65;
      const x = o.center[0] + Math.cos(a) * r;
      const z = o.center[2] + Math.sin(a) * r;
      const kind = rng.weighted(
        [
          CoralKind.Brain,
          CoralKind.Branching,
          CoralKind.Sponge,
          CoralKind.Whip,
        ],
        [3, 3, 2, 2],
      );
      place(kind, x, z, rng.range(0.3, 0.7), 0.6);
    }
  }

  // A scattering of lone coral heads and sponges across reef-mask ground.
  const center = ctx.nav.o.center;
  // Carpet the reef zones (ridge crests and flanks) so coral grows up the
  // slopes, not just in clumps on flat sand.
  for (let i = 0; i < ctx.count(9000); i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * (ctx.desc.terrain.basinRadius + 10);
    const x = center[0] + Math.cos(a) * r;
    const z = center[1] + Math.sin(a) * r;
    const reef = ctx.terrain.maskAt(1, x, z);
    if (rng.float() > reef * reef * 0.95 + 0.02) {
      continue;
    }
    const kind = rng.weighted(
      [
        CoralKind.Branching,
        CoralKind.Brain,
        CoralKind.Sponge,
        CoralKind.Whip,
        CoralKind.Table,
      ],
      [2, 3, 2, 2, 1],
    );
    // Mixed scales (many small, a few large) so the carpet never tiles.
    const scale = 0.3 + Math.pow(rng.float(), 2.2) * 1.2;
    place(kind, x, z, scale, 0.5, true);
  }

  return createPropKind(renderer, {
    name: 'coral',
    mesh,
    instances,
    wgsl: materialWgsl,
  });
}
