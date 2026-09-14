// Boulders and pebbles: noise-displaced, plane-chiselled spheres with
// encrusting growth on their upper faces.

import {buildMesh, withCoarseCopies, type Patch} from '../meshgen.ts';
import {createPropKind, quatUpYaw, type Instance} from '../../render/props.ts';
import type {Renderer, RenderSystem} from '../../render/renderer.ts';
import type {GenContext} from '../../world/layout.ts';
import {scatter} from '../../world/scatter.ts';
import propsWgsl from '../../shaders/props.wgsl';

const surfaceWgsl = /* wgsl */ `
fn surface(pat: Patch, uv: vec2f) -> SurfacePoint {
  let theta = uv.x * 6.2831853;
  let phi = uv.y * 3.14159265;
  // Parameterised so d/du x d/dv points outward (counter-clockwise front faces).
  let dir = vec3f(sin(phi) * cos(theta), -cos(phi), -sin(phi) * sin(theta));
  let shape = pat.p0.xyz;
  let lumpy = pat.p0.w;
  let seedOff = pat.p1.xyz;
  let strataFreq = pat.p1.w;

  // Domain-warped lumps: big organic masses rather than a smooth ellipsoid.
  let q = dir * 1.1 + seedOff;
  let warp = vec3f(fbm3(q * 0.9 + 3.1, 2), fbm3(q * 0.9 + 7.7, 2), fbm3(q * 0.9 + 1.3, 2));
  var disp = fbm3(q + warp * 0.8, 4) * lumpy;
  var p = dir * shape * (1.0 + disp);

  // Eroded strata: horizontal ledges that bulge out and undercut, giving
  // overhangs and crevices between layers.
  // Layers of uneven thickness (warped heavily), and each ledge only juts out
  // on some sides, so the rock never reads as a stack of even plates.
  let layer = p.y * strataFreq + fbm3(q * 1.1, 3) * 1.6;
  let f = fract(layer);
  let ledge = smoothstep(0.0, 0.25, f) * (1.0 - smoothstep(0.55, 1.0, f));
  let side = normalize(vec3f(p.x, 0.0, p.z) + vec3f(1e-4));
  let horizontal = 1.0 - abs(dir.y);
  let patchy = smoothstep(-0.15, 0.35, fbm3(q * 0.9 + vec3f(floor(layer) * 7.3), 2));
  p += side * (ledge - 0.45) * 0.1 * length(shape) * horizontal * patchy;

  // Porous surface: pits and pockets.
  // Pits cluster in eroded patches of mixed sizes instead of an even stamp.
  let pits = min(worley3(q * 6.0 + warp), worley3(q * 13.0 + warp * 2.0) + 0.08);
  let pitMask = smoothstep(-0.1, 0.35, fbm3(q * 1.3 + 11.0, 2));
  let pocket = smoothstep(0.25, 0.0, pits) * pitMask;
  p -= dir * pocket * 0.045 * length(shape);
  p += dir * fbm3(q * 9.0, 2) * 0.012 * length(shape);

  // Flatten the underside so rocks sit on the sand.
  let bottom = -shape.y * 0.45;
  p.y = max(p.y, bottom + (p.y - bottom) * 0.15);

  var o = sp(p, vec4f(uv, pocket, ledge));
  // Pockets, undercuts and undersides are occluded.
  o.ao = clamp(0.7 + disp * 1.2 + dir.y * 0.2 - pocket * 0.5 - (1.0 - ledge) * 0.15 * horizontal, 0.2, 1.0);
  return o;
}
`;

const materialWgsl = /* wgsl */ `
${propsWgsl}

fn deform(p: vec3f, n: vec3f, uv: vec4f, inst: Instance, t: f32) -> Deformed {
  return Deformed(p, n);
}

fn material(i: VOut, nIn: vec3f, inst: Instance) -> Surface {
  let lp = i.local * inst.posScale.w + inst.color.a * 17.0;
  let big = triplanarDetail(lp, nIn, 0.16);
  let mid = triplanarDetail(lp, nIn, 0.65);
  let fine = triplanarDetail(lp, nIn, 2.8);
  let pocket = i.uv.z;

  // Rough, granular relief (no cell/crack pattern).
  let height = big.r * 0.7 + mid.r * 0.35 + fine.r * 0.12 - pocket * 0.6;
  // Relief (for the colour below) vs. the bump: the bump skips the fine layer,
  // whose texel-scale noise would dither the normal at a distance.
  let n = bumpFromHeight(nIn, i.world, big.r * 0.7 + mid.r * 0.35 - pocket * 0.6, 0.22);

  // Stone: muted, layered greys and browns.
  let band = 0.5 + 0.5 * sin(lp.y * 4.0 + big.r * 5.0);
  var albedo = mix(vec3f(0.19, 0.17, 0.15), vec3f(0.36, 0.32, 0.27), big.r * 0.6 + band * 0.25 + mid.a * 0.15);
  albedo *= (0.8 + 0.3 * fine.r) * inst.color.rgb;
  // Pockets are shaded by AO; their albedo only darkens a little, and their
  // lips carry colour, so they read as holes rather than black decals.
  albedo *= mix(1.0, 0.7, pocket);

  // Encrusting life follows the rock's shape: algal turf settles on ledge
  // tops and in the lips of pockets, pink coralline crust creeps out of
  // sheltered crevices and undercuts, tiny pale polyps/barnacles speckle rims.
  let up = smoothstep(0.1, 0.8, nIn.y) * inst.params.x;
  let occl = 1.0 - i.aoMat.x;
  let ledgeTop = i.uv.w * smoothstep(-0.2, 0.5, nIn.y);
  let rim = smoothstep(0.02, 0.2, pocket) * (1.0 - smoothstep(0.35, 0.8, pocket));
  let turfField = mid.r * 0.45 + big.r * 0.3 + ledgeTop * 0.35 + rim * 0.3 + (fine.r - 0.5) * 0.3;
  let turf = smoothstep(0.5, 0.68, turfField) * up;
  let algae = mix(vec3f(0.19, 0.2, 0.1), vec3f(0.33, 0.27, 0.15), fine.g);
  let crustField = triplanarDetail(lp, nIn, 0.33).a * 0.7 + occl * 0.6 + rim * 0.2;
  let crust = smoothstep(0.68, 0.8, crustField) * inst.params.x * (1.0 - turf);
  let coralline = mix(vec3f(0.6, 0.32, 0.36), vec3f(0.74, 0.5, 0.47), fine.b);
  let specks = smoothstep(0.84, 0.9, fine.a) * max(up, rim) * (1.0 - pocket);
  var c = mix(albedo, algae, turf * 0.85);
  c = mix(c, coralline, crust * 0.75);
  c = mix(c, vec3f(0.75, 0.72, 0.64), specks * 0.6);

  var s = defaultSurface();
  s.albedo = c;
  s.normal = n;
  // Wet stone: bare upper faces and ridges carry a soft sheen, turf and
  // crust stay matte.
  let ridge = max(smoothstep(0.5, 0.8, height), smoothstep(0.3, 0.9, nIn.y) * 0.6) * (1.0 - turf) * (1.0 - crust);
  s.roughness = mix(0.85, 0.34, ridge);
  s.ao = i.aoMat.x * mix(1.0, 0.45, smoothstep(0.1, 0.6, pocket));
  s.f0 = 0.04;
  return s;
}
`;

export async function createRocks(
  renderer: Renderer,
  ctx: GenContext,
): Promise<RenderSystem> {
  const rng = ctx.rng('rocks');
  const hi = ctx.quality.tierIndex >= 2;
  const variants: {patches: Patch[]; radius: number}[] = [];
  const VARIANTS = 10;
  for (let v = 0; v < VARIANTS; v++) {
    const flat = rng.range(0.45, 1.0);
    const shape = [rng.range(0.8, 1.3), flat, rng.range(0.8, 1.3)];
    variants.push({
      patches: [
        {
          segU: hi ? 96 : 40,
          segV: hi ? 64 : 26,
          params: [
            ...shape,
            rng.range(0.25, 0.55),
            rng.range(-50, 50),
            rng.range(-50, 50),
            rng.range(-50, 50),
            rng.range(1.5, 4),
          ],
        },
      ],
      radius: 1.6,
    });
  }
  // Pillars: tall, lumpy columns for bommies, with only a few broad ledges so
  // they read as eroded reef heads rather than stacked plates.
  const PILLARS = 4;
  for (let v = 0; v < PILLARS; v++) {
    variants.push({
      patches: [
        {
          segU: hi ? 96 : 40,
          segV: hi ? 96 : 36,
          params: [
            rng.range(0.8, 1.0),
            rng.range(1.6, 2.0),
            rng.range(0.8, 1.0),
            rng.range(0.28, 0.4),
            rng.range(-50, 50),
            rng.range(-50, 50),
            rng.range(-50, 50),
            // Eroded ledges up the column.
            rng.range(1.4, 2.2),
          ],
        },
      ],
      radius: 2.6,
    });
  }
  // Low-detail stones for pebbles, rubble and distant boulders.
  const LOW = 3;
  const lowStart = variants.length;
  for (let v = 0; v < LOW; v++) {
    variants.push({
      patches: [
        {
          segU: hi ? 28 : 16,
          segV: hi ? 16 : 10,
          params: [
            rng.range(0.8, 1.3),
            rng.range(0.5, 0.9),
            rng.range(0.8, 1.3),
            rng.range(0.25, 0.45),
            rng.range(-50, 50),
            rng.range(-50, 50),
            rng.range(-50, 50),
            rng.range(1.5, 3),
          ],
        },
      ],
      radius: 1.6,
    });
  }
  // Distance stand-ins are coarse copies of the same rocks, so nothing changes
  // shape when they swap.
  const lod = withCoarseCopies(variants, i => i < VARIANTS + PILLARS);
  const mesh = await buildMesh(
    renderer.device,
    'rocks',
    surfaceWgsl,
    lod.variants,
    rng.nextU32(),
  );

  const instances: Instance[] = [];
  // A few stone types per basin (pale limestone, grey-blue basalt, dark
  // weathered rock), so neighbouring rocks don't all read as the same clay.
  const families: [number, number, number][] = [
    [1.25, 1.15, 0.95], // pale limestone
    [0.8, 0.88, 1.0], // grey-blue basalt
    [0.62, 0.58, 0.55], // dark weathered rock
    [1.2, 0.98, 0.72], // ochre sandstone
    [1.05, 0.9, 0.9], // pinkish coralline-crusted
  ];
  // Each basin has its own geology: two or three stone families.
  const stones = rng.shuffle([...families]).slice(0, rng.int(2, 3));
  const tint = (): [number, number, number, number] => {
    const st = rng.weighted(stones, [4, 2, 1].slice(0, stones.length));
    const b = rng.range(0.85, 1.12);
    return [st[0] * b, st[1] * b, st[2] * b, rng.range(0, 100)];
  };
  const place = (
    x: number,
    z: number,
    scale: number,
    sink: number,
    growth: number,
    onTop = false,
    pillar = false,
    low = false,
  ) => {
    // Stacked rocks sit on whatever is already there (terrain or other rocks).
    const base = onTop ? ctx.surfaceTop(x, z) : ctx.groundY(x, z);
    const y = base - scale * sink;
    const n = ctx.terrain.normalAt(x, z);
    const up: [number, number, number] = [n[0] * 0.6, 1, n[2] * 0.6];
    instances.push({
      pos: [x, y, z],
      scale,
      rot: quatUpYaw(up, rng.range(0, Math.PI * 2)),
      color: tint(),
      params: [growth * rng.range(0.45, 1), 0, 0, 0],
      variant: pillar
        ? VARIANTS + rng.int(0, PILLARS - 1)
        : low
          ? lowStart + rng.int(0, LOW - 1)
          : rng.int(0, VARIANTS - 1),
    });
    if (pillar) {
      ctx.occupied.add(x, z, scale * 0.9);
      // A stack of spheres up the column, so the camera, fish and the coral
      // that encrusts its top all see its real height.
      // Tapering, like the column, so things resting on the stack sit on
      // the rock rather than on a sphere bulging past it.
      for (const [k, r] of [
        [0.1, 1.0],
        [0.8, 0.8],
        [1.4, 0.6],
      ]) {
        ctx.obstacles.push({
          center: [x, y + scale * k, z],
          radius: scale * r,
        });
      }
    } else if (scale > 1.2) {
      ctx.occupied.add(x, z, scale * 0.9);
      ctx.obstacles.push({
        center: [x, y + scale * 0.2, z],
        radius: scale * 1.05,
      });
    }
  };

  // Bommies: at the most important reef clusters, a coral head rises well
  // above head height: a tall lumpy pillar with boulders buttressing its foot
  // and a smaller head perched off-centre on top, so its silhouette has a
  // shoulder and an overhang. Coral later encrusts its top and ledges.
  for (const c of ctx.clusters.slice(0, 3)) {
    const cx = c.x + rng.range(-1, 1);
    const cz = c.z + rng.range(-1, 1);
    const big = c.rank === 0;
    const scale = rng.range(1.6, 2.0) * (big ? 1.15 : 0.9);
    place(cx, cz, scale, 0.25, 1, false, true);
    const buttresses = rng.int(3, 5);
    for (let s = 0; s < buttresses; s++) {
      const a = (s / buttresses) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const r = scale * rng.range(0.9, 1.3);
      place(
        cx + Math.cos(a) * r,
        cz + Math.sin(a) * r,
        scale * rng.range(0.45, 0.7),
        0.35,
        1,
      );
    }
    // Only occasionally a second head on top; usually coral crowns the pillar.
    if (rng.bool(0.25)) {
      const a = rng.range(0, Math.PI * 2);
      place(
        cx + Math.cos(a) * scale * 0.45,
        cz + Math.sin(a) * scale * 0.45,
        scale * rng.range(0.5, 0.6),
        0.4,
        1,
        true,
        true,
      );
    }
  }

  // Foundation rocks under each reef cluster.
  for (const c of ctx.clusters) {
    const n = rng.int(2, 4) + (c.rank === 0 ? 2 : 0);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, c.radius * 0.7);
      place(
        c.x + Math.cos(a) * r,
        c.z + Math.sin(a) * r,
        rng.range(1.2, 2.8) * (c.rank === 0 ? 1.2 : 1),
        0.35,
        1,
      );
    }
  }

  // Reef framework along the spur ridges: stacked, ledged boulders on the
  // flanks give the ridges overhangs and a broken silhouette.
  const center = ctx.nav.o.center;
  const framework = scatter(rng, {
    count: ctx.count(160),
    minDist: 1.8,
    center,
    radius: ctx.desc.terrain.basinRadius,
    density: (x, z) => {
      const reef = ctx.terrain.maskAt(1, x, z);
      const n = ctx.terrain.normalAt(x, z);
      // Flanks: reef zones that are sloped.
      return reef > 0.6 ? Math.min(1, (1 - n[1]) * 6) * reef : 0;
    },
  });
  for (const [x, z] of framework) {
    place(x, z, rng.range(0.6, 1.9), rng.range(0.15, 0.4), 1);
  }

  // Boulders across rocky ground.
  const boulders = scatter(
    rng,
    {
      count: ctx.count(90),
      minDist: 3,
      center,
      radius: ctx.desc.terrain.basinRadius + 25,
      density: (x, z) => 0.08 + ctx.terrain.maskAt(0, x, z) * 0.9,
    },
    ctx.occupied,
  );
  for (const [x, z] of boulders) {
    const s = 0.4 + Math.pow(rng.float(), 2.5) * 3.2;
    place(x, z, s, rng.range(0.2, 0.45), rng.range(0.4, 1));
  }

  // Pebbles and small stones, clustered near rocks.
  const pebbles = scatter(rng, {
    count: ctx.count(260),
    minDist: 0.6,
    center,
    radius: ctx.desc.terrain.basinRadius,
    density: (x, z) =>
      0.05 +
      ctx.terrain.maskAt(0, x, z) * 0.6 +
      ctx.terrain.maskAt(1, x, z) * 0.3,
  });
  for (const [x, z] of pebbles) {
    place(
      x,
      z,
      rng.range(0.07, 0.3),
      0.3,
      rng.range(0, 0.6),
      false,
      false,
      true,
    );
  }

  // Rubble over the reef mounds and rocky ground: broken stones and old coral
  // fragments that break up the smooth terrain.
  const rubble = scatter(rng, {
    count: ctx.count(hi ? 1400 : 600),
    minDist: 0.45,
    center,
    radius: ctx.desc.terrain.basinRadius + 5,
    density: (x, z) =>
      Math.max(ctx.terrain.maskAt(0, x, z), ctx.terrain.maskAt(1, x, z)) > 0.45
        ? 0.9
        : 0.02,
    maxTries: 30000,
  });
  for (const [x, z] of rubble) {
    const sz = 0.06 + Math.pow(rng.float(), 2) * 0.3;
    place(
      x,
      z,
      sz,
      rng.range(0.25, 0.5),
      rng.range(0.3, 1),
      false,
      false,
      true,
    );
  }

  return createPropKind(renderer, {
    name: 'rocks',
    mesh,
    instances,
    wgsl: materialWgsl,
    cullMode: 'back',
    lod: {
      low: lod.low,
      distance: 28,
    },
    shadowMinRadius: 0.35,
  });
}
