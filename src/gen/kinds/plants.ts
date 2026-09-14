// Swaying plants: seagrass meadows, giant kelp forests, and gorgonian sea fans.

import {buildMesh, type Patch} from '../meshgen.ts';
import {createPropKind, quatUpYaw, type Instance} from '../../render/props.ts';
import type {Renderer, RenderSystem} from '../../render/renderer.ts';
import type {GenContext} from '../../world/layout.ts';
import {AuxBuilder} from '../tree.ts';
import {Rng} from '../../core/rng.ts';
import shapes from '../../shaders/shapes.wgsl';
import propsWgsl from '../../shaders/props.wgsl';
import {scatter} from '../../world/scatter.ts';

const Part = {
  Blade: 0,
  Stipe: 1,
  KelpBlade: 2,
  Bladder: 3,
} as const;

const plantSurface = /* wgsl */ `
${shapes}

/** Ribbon: p0 = base xyz + yaw, p1 = length, width, bend, lean; p2.x ruffle. */
fn ribbon(pat: Patch, uv: vec2f, part: f32) -> SurfacePoint {
  let len = pat.p1.x;
  let width = pat.p1.y;
  let yaw = pat.p0.w;
  let fwd = vec3f(cos(yaw), 0.0, -sin(yaw));
  let side = vec3f(sin(yaw), 0.0, cos(yaw));
  let v = uv.y;
  // Grass: tapering blade. Kelp: short stalk, then a long even ribbon that
  // narrows only near its tip.
  // Rounded tip: an elliptical cap over the last fifth of the blade.
  let tipT = clamp((v - 0.78) / 0.22, 0.0, 1.0);
  let kelpTaper = (smoothstep(0.0, 0.08, v) * 0.9 + 0.1) * sqrt(max(1.0 - tipT * tipT, 0.0)) * 0.97 + 0.03;
  let taper = select(1.0 - pow(v, 4.0), kelpTaper, part > 1.5);
  let across = (uv.x - 0.5) * width * taper;
  // Gentle ruffles along the blade edge (low frequency: a high one aliases into a sawtooth).
  let ruffle = sin(v * 13.0 + uv.x * 2.0 + pat.p0.w * 3.0) * pat.p2.x * pow(abs(uv.x - 0.5) * 2.0, 1.5) * v +
    sin(v * 31.0 + pat.p0.w * 7.0) * pat.p2.x * 0.35 * pow(abs(uv.x - 0.5) * 2.0, 2.0) * select(0.0, 1.0, part > 1.5);
  let bendAmt = pat.p1.z * v * v * len;
  var p = pat.p0.xyz + fwd * (bendAmt + pat.p1.w * v * len) + side * across;
  // Kelp blades hang out from the stipe; grass blades rise from the ground.
  if (part > 1.5) {
    // Kelp blades leave the stipe outward, then curve to stream downcurrent
    // (+x), drooping slightly; canopy blades lie nearly flat.
    let dir = normalize(vec3f(pat.p2.y, pat.p2.z, pat.p2.w));
    let stream = normalize(vec3f(1.0, mix(-0.25, 0.02, pat.p1.w), 0.3));
    let k = pat.p1.z;
    let along = dir * v * (1.0 - v * k * 0.5) + stream * v * v * k * 0.5;
    let tangent = normalize(dir * (1.0 - v * k) + stream * v * k);
    let s2 = normalize(cross(tangent, vec3f(0.0, 1.0, 0.0)) + vec3f(1e-4));
    let up2 = cross(s2, tangent);
    p = pat.p0.xyz + along * len + s2 * across + up2 * ruffle;
  } else {
    p.y += v * len * sqrt(max(1.0 - pat.p1.z * pat.p1.z, 0.1));
    p += fwd * ruffle;
  }
  var o = sp(p, vec4f(uv, pat.p0.y, part));
  o.ao = mix(0.35, 1.0, smoothstep(0.0, 0.6, v));
  return o;
}

fn bladder(pat: Patch, uv: vec2f) -> SurfacePoint {
  let theta = uv.x * TAU;
  let phi = uv.y * 3.14159;
  let dir = vec3f(sin(phi) * cos(theta), -cos(phi), -sin(phi) * sin(theta));
  var o = sp(pat.p0.xyz + dir * pat.p1.x * vec3f(1.0, 1.4, 1.0), vec4f(uv, 0.0, ${Part.Bladder}));
  o.normal = dir;
  return o;
}

fn surface(pat: Patch, uv: vec2f) -> SurfacePoint {
  switch (u32(pat.p3.w)) {
    case ${Part.Stipe}u: {
      var o = chainTube(u32(pat.p0.x), u32(pat.p0.y), uv, 0.02);
      o.uv = vec4f(uv.x, uv.y, 0.0, ${Part.Stipe});
      return o;
    }
    case ${Part.KelpBlade}u: { return ribbon(pat, uv, ${Part.KelpBlade}); }
    case ${Part.Bladder}u: { return bladder(pat, uv); }
    default: { return ribbon(pat, uv, ${Part.Blade}); }
  }
}
`;

const plantMaterial = /* wgsl */ `
${propsWgsl}

fn deform(p: vec3f, n: vec3f, uv: vec4f, inst: Instance, t: f32) -> Deformed {
  let part = u32(uv.w + 0.5);
  let h = max(p.y, 0.0);
  let strength = inst.params.y;
  var d = currentSway(inst.posScale.xyz + p * inst.posScale.w, h, t, strength, inst.params.x);
  if (part == ${Part.KelpBlade}u || part == ${Part.Blade}u) {
    // Blades flutter along their length.
    let flutter = sin(t * 2.3 + uv.y * 7.0 + inst.params.x + p.y * 3.0) * uv.y * 0.06;
    d += vec3f(flutter, 0.0, flutter * 0.6);
  }
  return Deformed(p + d / max(inst.posScale.w, 0.1), n);
}

fn material(i: VOut, nIn: vec3f, inst: Instance) -> Surface {
  // Blades right in front of the lens dissolve rather than smear the frame.
  let camD = length(frame.camPos - i.world);
  if (ign(i.pos.xy, frame.frameIndex * 3u + i.instance) > smoothstep(0.3, 1.0, camD)) {
    discard;
  }
  let part = u32(i.uv.w + 0.5);
  let tint = inst.color.rgb;
  var s = defaultSurface();
  s.normal = nIn;
  s.ao = i.aoMat.x;
  let veins = 0.5 + 0.5 * sin(i.uv.x * 26.0 + i.uv.y * 3.0);
  let along = i.uv.y;
  switch (part) {
    case ${Part.Stipe}u: {
      // Olive-brown, ropey stipes (warmer than the blades so they don't go blue
      // in silhouette against the water).
      s.albedo = tint * vec3f(0.85, 0.66, 0.42) * (0.9 + 0.2 * veins);
      s.translucency = 0.5;
      // Slimy but not glossy: a smooth stipe mirrors the blue water at its
      // grazing edges and turns into a bright blue rod.
      s.roughness = 0.85;
    }
    case ${Part.Bladder}u: {
      s.albedo = tint * vec3f(1.1, 1.0, 0.7);
      s.translucency = 0.6;
      s.roughness = 0.3;
      s.f0 = 0.05;
    }
    default: {
      // Blades: darker at the base, golden and translucent toward the tips,
      // with faint longitudinal veins and ragged dead tips.
      // Soft mottling instead of drawn veins: slightly thicker patches let a
      // little less light through.
      let mottle = 0.5 + 0.5 * sin(i.uv.y * 9.0 + veins * 2.0);
      var c = tint * mix(0.55, 1.15, smoothstep(0.0, 0.8, along)) * (0.94 + 0.06 * mottle);
      c = mix(c, tint * vec3f(1.2, 1.05, 0.6), smoothstep(0.85, 1.0, along) * 0.5);
      s.albedo = c;
      s.translucency = 0.9 + 0.08 * mottle;
      // Slick but not mirror-like: sharp highlights read as white slivers.
      s.roughness = 0.72;
      s.f0 = 0.02;
      // Lower blades sit in the canopy's shade.
      s.ao *= mix(0.55, 1.0, smoothstep(-14.0, -3.0, i.world.y));
      // Seen from below, a thin blade glows with the bright water above it:
      // light filtered through the tissue comes out saturated yellow-green.
      if (part == ${Part.KelpBlade}u) {
        let V = normalize(frame.camPos - i.world);
        let under = smoothstep(0.0, 0.7, -V.y);
        let glowCol = tint * vec3f(1.1, 1.25, 0.45) + vec3f(0.02, 0.05, 0.0);
        s.emissive = glowCol * sunAtDepth(i.world.y) * 0.022 * under * (0.8 + 0.4 * mottle) *
          smoothstep(0.05, 0.4, along);
      }
    }
  }
  return s;
}
`;

// ---------------------------------------------------------------------------
// Sea fans (gorgonians): a curved fan surface with an alpha-tested lattice.

const fanSurface = /* wgsl */ `
${shapes}

fn surface(pat: Patch, uv: vec2f) -> SurfacePoint {
  let R = pat.p0.x;
  let spread = pat.p0.y;
  let alpha = (uv.x - 0.5) * spread;
  let r = uv.y * R;
  let bend = pat.p0.z * r * r + fbm2(vec2f(alpha * 3.0, r * 2.0) + pat.p1.xy, 3) * 0.08 * r;
  let p = vec3f(sin(alpha) * r, cos(alpha) * r * 0.9, bend);
  var o = sp(p, vec4f(uv, pat.p0.w, 0.0));
  o.normal = normalize(vec3f(-2.0 * pat.p0.z * p.x * 0.1, -0.0, 1.0));
  return o;
}
`;

const fanMaterial = /* wgsl */ `
${propsWgsl}

fn fanCoords(uv: vec4f) -> vec2f {
  let spread = 2.2;
  let alpha = (uv.x - 0.5) * spread;
  let r = uv.y;
  return vec2f(sin(alpha), cos(alpha)) * r;
}

fn alphaMask(uv: vec4f, local: vec3f, inst: Instance) -> f32 {
  let q = fanCoords(uv) * inst.params.z + inst.params.x;
  // A lattice of thin branches: Worley cell edges, plus radial main branches.
  let w = worley2p(q, vec2i(0));
  let edge = w.y - w.x;
  let thickness = mix(0.09, 0.03, uv.y);
  let lattice = step(edge, thickness);
  let angle = (uv.x - 0.5) * 9.0;
  let radial = step(abs(fract(angle * 1.5 + 0.5) - 0.5), mix(0.12, 0.03, uv.y));
  // Ragged outline and a solid base.
  let outline = step(uv.y, 0.92 + 0.08 * sin(uv.x * 31.0 + inst.params.x));
  let base = step(uv.y, 0.08) * step(abs(uv.x - 0.5), 0.15);
  return max(max(lattice, radial) * outline, base);
}

fn deform(p: vec3f, n: vec3f, uv: vec4f, inst: Instance, t: f32) -> Deformed {
  let h = max(p.y, 0.0);
  // Fans rock back and forth as a whole (they face into the current).
  let rock = sin(t * 0.8 + inst.params.x) * 0.06 * h;
  return Deformed(p + vec3f(0.0, 0.0, rock + sin(t * 1.3 + p.x * 4.0 + inst.params.x) * 0.015 * h), n);
}

fn material(i: VOut, nIn: vec3f, inst: Instance) -> Surface {
  if (alphaMask(i.uv, i.local, inst) < 0.5) {
    discard;
  }
  var s = defaultSurface();
  let tip = smoothstep(0.5, 1.0, i.uv.y);
  s.albedo = mix(inst.color.rgb * 0.7, inst.color.rgb * 1.1, tip);
  s.normal = nIn;
  s.translucency = 0.7;
  s.roughness = 0.6;
  s.ao = mix(0.5, 1.0, i.uv.y);
  return s;
}
`;

interface Variant {
  patches: Patch[];
  radius: number;
}

const P = (
  params: number[],
  part: number,
  segU: number,
  segV: number,
): Patch => {
  const p = new Array(16).fill(0);
  params.forEach((v, i) => (p[i] = v));
  p[15] = part;
  return {segU, segV, params: p};
};

function grassClump(rng: Rng, hi: boolean): Variant {
  const blades = hi ? rng.int(14, 22) : rng.int(7, 11);
  const patches: Patch[] = [];
  const radius = rng.range(0.15, 0.35);
  for (let b = 0; b < blades; b++) {
    const a = rng.range(0, Math.PI * 2);
    const d = Math.sqrt(rng.float()) * radius;
    patches.push(
      P(
        [
          Math.cos(a) * d,
          0,
          Math.sin(a) * d,
          rng.range(0, Math.PI * 2),
          rng.range(0.35, 0.8),
          // Wide enough to stay above a pixel at mid distance (thin blades alias).
          rng.range(0.028, 0.045),
          rng.range(0.05, 0.35),
          rng.range(-0.05, 0.1),
          rng.range(0.0, 0.004),
        ],
        Part.Blade,
        1,
        hi ? 8 : 5,
      ),
    );
  }
  return {patches, radius: radius + 0.8};
}

function kelpPlant(
  rng: Rng,
  aux: AuxBuilder,
  height: number,
  hi: boolean,
  /** Same plant (same random choices) with coarse tessellation, for distance. */
  coarse = false,
): Variant {
  const patches: Patch[] = [];
  // Giant kelp: a holdfast sends up several stipes that all climb to the
  // surface, leaning and curving as they rise, with long golden blades that
  // stream downcurrent and a floating canopy mat at the top.
  const stipes = rng.int(2, 5);
  for (let st = 0; st < stipes; st++) {
    // Young stipes stop short of the surface, so stands have layered heights.
    const h =
      height * (rng.bool(0.3) ? rng.range(0.45, 0.75) : rng.range(0.88, 1.0));
    const segs = Math.max(8, Math.round(h * 2.2));
    const points: [number, number, number, number][] = [];
    const baseA = rng.range(0, Math.PI * 2);
    const spread = rng.range(0.1, 0.5);
    const bendA = rng.range(-0.6, 0.6); // lean mostly downcurrent (+x)
    const bend = rng.range(1.0, 3.0);
    const wave = rng.range(0.8, 2.0);
    const phase = rng.range(0, Math.PI * 2);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const drift = spread * t + bend * t * t;
      const w = Math.sin(t * Math.PI * wave + phase) * 0.5 * t;
      points.push([
        Math.cos(baseA) * 0.08 +
          Math.cos(bendA) * drift +
          Math.cos(bendA + 1.57) * w,
        t * h,
        Math.sin(baseA) * 0.08 +
          Math.sin(bendA) * drift +
          Math.sin(bendA + 1.57) * w,
        0.028 * (1 - t * 0.5),
      ]);
    }
    const stipe = aux.addChain(points);
    patches.push(
      P(
        [stipe.offset, stipe.count],
        Part.Stipe,
        hi && !coarse ? 6 : 3,
        coarse ? segs : segs * 2,
      ),
    );

    // Few, broad blades: giant kelp reads as ribbons, not a leafy hedge.
    const bladeCount = Math.round(h * (hi ? 2.0 : 1.1));
    for (let b = 0; b < bladeCount; b++) {
      // Irregular spacing and direction, so blades never read as leaf pairs.
      // Blades grow along nearly the whole stipe; only the very base is bare.
      const t = 0.12 + Math.pow(rng.float(), 0.8) * 0.88;
      const idx = Math.min(
        points.length - 1,
        Math.max(0, Math.round(t * segs)),
      );
      const base = points[idx];
      // Blades hang off the downcurrent side of the stipe.
      const a = rng.normal(0, 0.7);
      // Blades in the top fifth lie along the surface as a canopy.
      const canopy = Math.max(0, (t - 0.8) / 0.2);
      const outward = [
        Math.cos(a),
        rng.range(0.2, 0.6) * (1 - canopy),
        Math.sin(a),
      ];
      // Long narrow ribbons (not leaves): giant kelp blades trail far downstream.
      const len = rng.range(1.4, 3.8) * (1 + canopy * 0.6);
      patches.push(
        P(
          [
            base[0] + Math.cos(a) * 0.04,
            base[1],
            base[2] + Math.sin(a) * 0.04,
            a,
            len,
            rng.range(0.22, 0.34),
            // How strongly the blade streams downcurrent along its length.
            rng.range(0.45, 0.8) + canopy * 0.2,
            canopy,
            rng.range(0.05, 0.09),
            ...outward,
          ],
          Part.KelpBlade,
          hi && !coarse ? 4 : 1,
          hi && !coarse ? 22 : 6,
        ),
      );
      // Every blade springs from a gas bladder.
      if (rng.bool(0.9)) {
        patches.push(
          P(
            [
              base[0] + Math.cos(a) * 0.035,
              base[1],
              base[2] + Math.sin(a) * 0.035,
              0,
              rng.range(0.03, 0.05),
            ],
            Part.Bladder,
            coarse ? 4 : 8,
            coarse ? 3 : 6,
          ),
        );
      }
    }
  }
  // Canopy mat: long fronds from the top of the holdfast's stipes spread out
  // flat just under the surface, overlapping into a dark, light-dappling mat.
  const mat = hi ? rng.int(18, 26) : rng.int(10, 14);
  for (let m = 0; m < mat; m++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0, 0.6);
    patches.push(
      P(
        [
          Math.cos(a) * r + rng.range(0.5, 2.0),
          height * rng.range(0.97, 1.0),
          Math.sin(a) * r,
          a,
          rng.range(3.0, 5.5),
          rng.range(0.16, 0.26),
          rng.range(0.3, 0.6),
          1,
          rng.range(0.04, 0.08),
          Math.cos(a),
          rng.range(-0.05, 0.08),
          Math.sin(a),
        ],
        Part.KelpBlade,
        hi && !coarse ? 4 : 1,
        hi && !coarse ? 24 : 7,
      ),
    );
  }
  return {patches, radius: height};
}

function fanVariant(rng: Rng, hi: boolean): Variant {
  const R = rng.range(0.5, 1.1);
  return {
    patches: [
      P(
        [
          R,
          2.2,
          rng.range(-0.3, 0.3),
          0,
          rng.range(-20, 20),
          rng.range(-20, 20),
        ],
        0,
        hi ? 24 : 12,
        hi ? 16 : 8,
      ),
    ],
    radius: R,
  };
}

export async function createPlants(
  renderer: Renderer,
  ctx: GenContext,
): Promise<RenderSystem[]> {
  const rng = ctx.rng('plants');
  const hi = ctx.quality.tierIndex >= 2;
  const aux = new AuxBuilder();
  const variants: Variant[] = [];
  const grassVariants: number[] = [];
  const kelpVariants: number[] = [];
  const kelpHeights: number[] = [];
  for (let i = 0; i < 6; i++) {
    grassVariants.push(variants.length);
    variants.push(grassClump(rng, hi));
  }
  const kelpLow: [number, number][] = [];
  for (let i = 0; i < 5; i++) {
    kelpVariants.push(variants.length);
    const kelpHeight = rng.range(9, 14);
    kelpHeights.push(kelpHeight);
    const seed = rng.nextU32();
    variants.push(kelpPlant(new Rng(seed), aux, kelpHeight, hi));
    kelpLow.push([variants.length - 1, variants.length]);
    variants.push(kelpPlant(new Rng(seed), aux, kelpHeight, hi, true));
  }
  const mesh = await buildMesh(
    renderer.device,
    'plants',
    plantSurface,
    variants,
    rng.nextU32(),
    aux.build(),
  );

  const instances: Instance[] = [];
  const center = ctx.nav.o.center;
  const R = ctx.desc.terrain.basinRadius;
  const grassTint = (): [number, number, number, number] => {
    const g = rng.range(0.85, 1.1);
    return [0.32 * g, 0.5 * g, 0.16 * g, 0];
  };

  // Seagrass meadows on sandy ground with the plant mask.
  const meadow = scatter(rng, {
    count: ctx.count(hi ? 2000 : 1200),
    minDist: 0.35,
    center,
    radius: R + 15,
    density: (x, z) => {
      const m = ctx.terrain.maskAt(2, x, z);
      return m > 0.35
        ? Math.min(1, (m - 0.35) * 2.5) * (1 - ctx.terrain.maskAt(0, x, z))
        : 0;
    },
    maxTries: 60000,
  });
  for (const [x, z] of meadow) {
    const n = ctx.terrain.normalAt(x, z);
    instances.push({
      pos: [x, ctx.groundY(x, z) - 0.02, z],
      scale: rng.range(0.7, 1.3),
      rot: quatUpYaw([n[0] * 0.5, 1, n[2] * 0.5], rng.range(0, Math.PI * 2)),
      color: grassTint(),
      params: [rng.range(0, 100), 0.35, 0, 0],
      variant: rng.pick(grassVariants),
    });
  }

  // One or two kelp forests where the plant mask is strongest.
  let best: [number, number] = [center[0], center[1]];
  let bestScore = -1;
  for (let i = 0; i < 400; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * R * 0.85;
    const x = center[0] + Math.cos(a) * r;
    const z = center[1] + Math.sin(a) * r;
    const nearReef = ctx.clusters.some(
      c => Math.hypot(c.x - x, c.z - z) < c.radius + 6,
    );
    const score =
      ctx.terrain.maskAt(2, x, z) - (nearReef ? 1 : 0) + rng.range(0, 0.2);
    if (score > bestScore) {
      bestScore = score;
      best = [x, z];
    }
  }
  const forests = rng.bool(0.6) ? 2 : 1;
  for (let f = 0; f < forests; f++) {
    const fc: [number, number] =
      f === 0
        ? best
        : [best[0] + rng.range(-25, 25), best[1] + rng.range(-25, 25)];
    // Clumps of holdfasts rather than an even grid, so the forest has dense
    // stands and darker gaps.
    const clumps = scatter(
      rng,
      {
        // Stands with open lanes between them, so blue water shows through.
        count: ctx.count(hi ? 26 : 16),
        minDist: 3.2,
        center: fc,
        radius: rng.range(10, 15),
        density: (x, z) => (ctx.terrain.maskAt(0, x, z) < 0.6 ? 1 : 0.2),
      },
      ctx.occupied,
    );
    const surface = ctx.desc.surfaceY;
    const stems: [number, number][] = [];
    for (const [cx, cz] of clumps) {
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) {
        const x = cx + rng.range(-1.2, 1.2);
        const z = cz + rng.range(-1.2, 1.2);
        const y = ctx.groundY(x, z);
        const vi = rng.int(0, kelpVariants.length - 1);
        // Tall enough that the canopy spreads just under the surface.
        const scale = Math.min(
          1.8,
          Math.max(
            0.5,
            ((surface - 0.4 - y) / kelpHeights[vi]) * rng.range(0.95, 1.05),
          ),
        );
        const g = rng.range(0.85, 1.1);
        instances.push({
          pos: [x, y - 0.05, z],
          scale,
          // Little yaw: the blades are modelled streaming along the current (+x).
          rot: quatUpYaw(
            [rng.range(-0.05, 0.05), 1, rng.range(-0.05, 0.05)],
            rng.range(-0.3, 0.3),
          ),
          // Olive-brown: saturated yellow turns saffron when backlit.
          color: [0.4 * g, 0.37 * g, 0.18 * g, 0],
          params: [rng.range(0, 100), 0.024, 0, 0],
          variant: kelpVariants[vi],
        });
        stems.push([x, z]);
      }
    }
    ctx.kelpForests.push({x: fc[0], z: fc[1], radius: 12, stems});
  }

  // Sea fans on the edges of reef clusters, facing across the current.
  const fanMesh = await buildMesh(
    renderer.device,
    'fans',
    fanSurface,
    [0, 1, 2, 3].map(() => fanVariant(rng, hi)),
    rng.nextU32(),
  );
  const fanColors: [number, number, number][] = [
    [0.85, 0.2, 0.2],
    [0.75, 0.3, 0.7],
    [0.95, 0.65, 0.2],
    [0.9, 0.85, 0.35],
  ];
  const fans: Instance[] = [];
  for (const c of ctx.clusters) {
    const count = ctx.count(rng.int(1, 4) * (c.rank === 0 ? 2 : 1));
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = c.radius * rng.range(0.5, 1.1);
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      const col = rng.pick(fanColors);
      fans.push({
        pos: [x, ctx.surfaceTop(x, z) - 0.03, z],
        scale: rng.range(0.7, 1.5),
        // Face roughly into the current (+x), like real gorgonians.
        rot: quatUpYaw(
          [rng.range(-0.1, 0.1), 1, rng.range(-0.1, 0.1)],
          Math.PI / 2 + rng.range(-0.5, 0.5),
        ),
        color: [col[0], col[1], col[2], 0],
        params: [rng.range(0, 100), 0, rng.range(9, 14), 0],
        variant: rng.int(0, 3),
      });
    }
  }

  return Promise.all([
    createPropKind(renderer, {
      name: 'plants',
      mesh,
      instances,
      wgsl: plantMaterial,
      lod: {
        low: variants.map((_, v) => kelpLow.find(k => k[0] === v)?.[1] ?? -1),
        distance: 14,
      },
    }),
    createPropKind(renderer, {
      name: 'fans',
      mesh: fanMesh,
      instances: fans,
      wgsl: fanMaterial,
      alphaTest: true,
    }),
  ]);
}
