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
  let height = big.r * 0.7 + mid.r * 0.35 + fine.a * 0.25 - pocket * 0.6;
  let n = bumpFromHeight(nIn, i.world, height, 0.22);

  // Stone: muted, layered greys and browns.
  let band = 0.5 + 0.5 * sin(lp.y * 4.0 + big.r * 5.0);
  var albedo = mix(vec3f(0.19, 0.17, 0.15), vec3f(0.36, 0.32, 0.27), big.r * 0.6 + band * 0.25 + mid.a * 0.15);
  albedo *= (0.8 + 0.3 * fine.r) * inst.color.rgb;
  albedo *= mix(1.0, 0.35, pocket);

  // Encrusting life on the upper faces: fine algal turf, speckles of pink
  // coralline crust and tiny pale polyps/barnacles.
  let up = smoothstep(0.1, 0.8, nIn.y) * inst.params.x;
  let turf = smoothstep(0.52, 0.7, mid.g * 0.5 + big.r * 0.5 + (fine.r - 0.5) * 0.35) * up;
  let algae = mix(vec3f(0.2, 0.2, 0.1), vec3f(0.32, 0.26, 0.14), fine.g);
  let crust = smoothstep(0.72, 0.8, triplanarDetail(lp, nIn, 0.33).a) * up;
  let coralline = mix(vec3f(0.62, 0.34, 0.36), vec3f(0.72, 0.5, 0.46), fine.b);
  let specks = smoothstep(0.84, 0.9, fine.a) * up;
  var c = mix(albedo, algae, turf * 0.85);
  c = mix(c, coralline, crust * 0.8);
  c = mix(c, vec3f(0.75, 0.72, 0.64), specks * 0.6);

  var s = defaultSurface();
  s.albedo = c;
  s.normal = n;
  // Mostly rough; a thin wet sheen only on bare, sunlit ridges.
  let ridge = smoothstep(0.55, 0.8, height) * (1.0 - turf) * (1.0 - crust);
  s.roughness = mix(0.82, 0.42, ridge);
  s.ao = i.aoMat.x;
  s.f0 = 0.035;
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
  const mesh = await buildMesh(
    renderer.device,
    'rocks',
    surfaceWgsl,
    variants,
    rng.nextU32(),
  );

  const instances: Instance[] = [];
  const tint = (): [number, number, number, number] => {
    const warm = rng.range(-0.08, 0.08);
    const b = rng.range(0.8, 1.15);
    return [b * (1 + warm), b, b * (1 - warm), rng.range(0, 100)];
  };
  const place = (
    x: number,
    z: number,
    scale: number,
    sink: number,
    growth: number,
  ) => {
    const y = ctx.groundY(x, z) - scale * sink;
    const n = ctx.terrain.normalAt(x, z);
    const up: [number, number, number] = [n[0] * 0.6, 1, n[2] * 0.6];
    instances.push({
      pos: [x, y, z],
      scale,
      rot: quatUpYaw(up, rng.range(0, Math.PI * 2)),
      color: tint(),
      params: [growth, 0, 0, 0],
      variant: rng.int(0, VARIANTS - 1),
    });
    if (scale > 1.2) {
      ctx.occupied.add(x, z, scale * 0.9);
      ctx.obstacles.push({
        center: [x, y + scale * 0.2, z],
        radius: scale * 1.05,
      });
    }
  };

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
