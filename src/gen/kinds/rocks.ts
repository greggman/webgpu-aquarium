// Boulders and pebbles: noise-displaced, plane-chiselled spheres with
// encrusting growth on their upper faces.

import {buildMesh, type Patch} from '../meshgen.ts';
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
  let layer = p.y * strataFreq + fbm3(q * 1.7, 2) * 0.6;
  let f = fract(layer);
  let ledge = smoothstep(0.0, 0.25, f) * (1.0 - smoothstep(0.55, 1.0, f));
  let side = normalize(vec3f(p.x, 0.0, p.z) + vec3f(1e-4));
  let horizontal = 1.0 - abs(dir.y);
  p += side * (ledge - 0.45) * 0.09 * length(shape) * horizontal;

  // Porous surface: pits and pockets.
  let pits = worley3(q * 6.0 + warp);
  let pocket = smoothstep(0.25, 0.0, pits);
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
            rng.range(0.4, 0.55),
            rng.range(-50, 50),
            rng.range(-50, 50),
            rng.range(-50, 50),
            rng.range(0.8, 1.3),
          ],
        },
      ],
      radius: 2.6,
    });
  }
  const mesh = await buildMesh(
    renderer.device,
    'rocks',
    surfaceWgsl,
    variants,
    rng.nextU32(),
  );

  const instances: Instance[] = [];
  // A few stone types per basin (pale limestone, grey-blue basalt, dark
  // weathered rock), so neighbouring rocks don't all read as the same clay.
  const stones: [number, number, number][] = [
    [1.2, 1.1, 0.92],
    [0.82, 0.88, 0.98],
    [0.66, 0.62, 0.58],
    [1.02, 0.94, 0.86],
  ];
  const tint = (): [number, number, number, number] => {
    const st = rng.weighted(stones, [3, 2, 2, 3]);
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
        : rng.int(0, VARIANTS - 1),
    });
    if (pillar) {
      ctx.occupied.add(x, z, scale * 0.9);
      // A stack of spheres up the column, so the camera, fish and the coral
      // that encrusts its top all see its real height.
      for (const k of [0.1, 0.8, 1.45]) {
        ctx.obstacles.push({
          center: [x, y + scale * k, z],
          radius: scale * 0.95,
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
    place(x, z, rng.range(0.07, 0.3), 0.3, rng.range(0, 0.6));
  }

  return createPropKind(renderer, {
    name: 'rocks',
    mesh,
    instances,
    wgsl: materialWgsl,
    cullMode: 'back',
  });
}
