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
  var p = dir * shape;

  // Large lumps and medium detail.
  let q = dir * 1.1 + seedOff;
  var disp = fbm3(q, 3) * lumpy + fbm3(q * 3.7 + 5.0, 3) * 0.08;
  // Horizontal strata.
  disp += (abs(fract(p.y * pat.p1.w + fbm3(q * 2.0, 2) * 0.4) - 0.5) - 0.25) * 0.05;
  p *= 1.0 + disp;

  // Chisel with a few random planes for faceted, broken-stone faces.
  for (var i = 0u; i < 6u; i++) {
    let h = vec3f(pcg3d(vec3u(i, pat.variant, 91u)) % vec3u(1000u)) / 500.0 - 1.0;
    let nrm = normalize(h + vec3f(0.0, 0.2, 0.0));
    let d = dot(p, nrm) - length(shape) * (0.42 + 0.1 * f32(i % 3u));
    if (d > 0.0) {
      p -= nrm * d * 0.6;
    }
  }
  // Flatten the underside so rocks sit on the sand.
  let bottom = -shape.y * 0.45;
  p.y = max(p.y, bottom + (p.y - bottom) * 0.15);

  var o = sp(p, vec4f(uv, 0.0, 0.0));
  // Crevices and undersides are occluded.
  o.ao = clamp(0.55 + disp * 1.5 + dir.y * 0.25, 0.25, 1.0);
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
  let big = triplanarDetail(lp, nIn, 0.18);
  let mid = triplanarDetail(lp, nIn, 0.7);
  let fine = triplanarDetail(lp, nIn, 2.6);
  let cells = big.g;
  // Cracks only in places (noise-masked) and thinner, so they don't tile into a mesh.
  let crackMask = smoothstep(0.45, 0.7, mid.r + (big.b - 0.5) * 0.4);
  let cracks = (1.0 - smoothstep(0.02, 0.12, cells)) * crackMask;
  let pits = smoothstep(0.62, 0.8, fine.a);

  // Crisp detail normal from a layered height field.
  let height = big.r * 0.8 + mid.g * 0.35 + fine.a * 0.12 - cracks * 0.5 - pits * 0.06;
  let n = bumpFromHeight(nIn, i.world, height, 0.18);

  // Stone: layered greys and browns with mineral banding.
  let band = 0.5 + 0.5 * sin(lp.y * 5.0 + big.r * 4.0);
  var albedo = mix(vec3f(0.2, 0.18, 0.16), vec3f(0.42, 0.38, 0.32), big.r * 0.7 + band * 0.3);
  albedo *= (0.75 + 0.35 * mid.r) * inst.color.rgb;
  albedo *= mix(1.0, 0.3, cracks);

  // Encrusting life on faces that catch the light: fine-grained, patchy, and
  // varied rather than a flat green coat.
  let hueSel = triplanarDetail(lp, nIn, 0.09).r;
  let algae = vec3f(0.18, 0.22, 0.09) * (0.7 + 0.6 * fine.r);
  let coralline = mix(vec3f(0.72, 0.3, 0.32), vec3f(0.82, 0.55, 0.6), fine.g);
  let sponge = vec3f(0.55, 0.32, 0.12);
  var growth = mix(algae, coralline, smoothstep(0.5, 0.58, hueSel));
  growth = mix(growth, sponge, smoothstep(0.66, 0.7, hueSel) * 0.9);
  let up = smoothstep(0.25, 0.85, nIn.y);
  let patchy = smoothstep(0.42, 0.62, mid.r + big.r * 0.35 + (fine.r - 0.5) * 0.3);
  let amount = clamp(up * patchy * inst.params.x * (1.0 - cracks), 0.0, 0.85);

  var s = defaultSurface();
  s.albedo = mix(albedo, growth, amount);
  s.normal = n;
  // Wet stone is fairly glossy; growth is matte.
  s.roughness = mix(mix(0.38, 0.62, mid.a), 0.85, amount);
  s.ao = i.aoMat.x * mix(1.0, 0.35, cracks);
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
          segU: hi ? 64 : 32,
          segV: hi ? 40 : 20,
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

  // Boulders across rocky ground.
  const center = ctx.nav.o.center;
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
