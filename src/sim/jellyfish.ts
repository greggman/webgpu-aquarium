// Jellyfish: translucent pulsing bells with frilled oral arms and trailing
// tentacles, softly bioluminescent. Drawn in the transparent pass.

import {createShader} from '../gpu/device.ts';
import type {NavSphere} from '../player/navvolume.ts';
import {sidePlanes, sphereInside} from '../render/frustum.ts';
import {
  buildMesh,
  vertexLayout,
  withLodChain,
  type Patch,
} from '../gen/meshgen.ts';
import {surfaceLib} from '../shaders/index.ts';
import shapes from '../shaders/shapes.wgsl';
import propsWgsl from '../shaders/props.wgsl';
import {
  DEPTH_FORMAT,
  HDR_FORMAT,
  type FrameContext,
  type Renderer,
  type RenderSystem,
} from '../render/renderer.ts';
import type {GenContext} from '../world/layout.ts';

const Part = {
  Bell: 0,
  InnerBell: 1,
  Arm: 2,
  Tentacle: 3,
} as const;

const meshWgsl = /* wgsl */ `
${shapes}

fn bellPoint(u: f32, v: f32, inner: bool) -> vec3f {
  // v: 0 at the apex, 1 at the rim.
  let a = u * TAU;
  let r = sin(v * 1.5707963) * (1.0 + 0.04 * sin(a * 8.0) * v * v);
  let h = cos(v * 1.5707963) * 0.65 - v * v * 0.08;
  let shrink = select(1.0, 0.9, inner);
  return vec3f(cos(a) * r * shrink, h * shrink - select(0.0, 0.03, inner), -sin(a) * r * shrink);
}

fn surface(pat: Patch, uv: vec2f) -> SurfacePoint {
  switch (u32(pat.p3.w)) {
    case ${Part.Bell}u: {
      var o = sp(bellPoint(uv.x, uv.y, false), vec4f(uv, uv.y, ${Part.Bell}));
      return o;
    }
    case ${Part.InnerBell}u: {
      var o = sp(bellPoint(1.0 - uv.x, uv.y, true), vec4f(uv, uv.y, ${Part.InnerBell}));
      return o;
    }
    case ${Part.Arm}u: {
      // Frilly oral arm hanging below the bell.
      let a = pat.p0.x;
      let len = pat.p0.y;
      let dir = vec3f(cos(a), 0.0, -sin(a));
      let side = vec3f(sin(a), 0.0, cos(a));
      let frill = sin(uv.y * 30.0 + uv.x * 4.0) * 0.05 * (uv.x - 0.5) * 2.0;
      let width = 0.12 * (1.0 - uv.y * 0.6);
      let p = dir * (0.12 + uv.y * 0.05) + side * (uv.x - 0.5) * width + dir * frill - vec3f(0.0, uv.y * len, 0.0);
      return sp(p, vec4f(uv, uv.y, ${Part.Arm}));
    }
    default: {
      let a = pat.p0.x;
      let len = pat.p0.y;
      let ang = uv.x * TAU;
      let r = 0.006 * (1.0 - uv.y * 0.7);
      let base = vec3f(cos(a) * 0.95, -0.02, -sin(a) * 0.95);
      let p = base + vec3f(cos(ang) * r, -uv.y * len, sin(ang) * r);
      var o = sp(p, vec4f(uv, uv.y, ${Part.Tentacle}));
      o.normal = vec3f(cos(ang), 0.0, sin(ang));
      return o;
    }
  }
}
`;

const renderWgsl = /* wgsl */ `
${surfaceLib}
${propsWgsl}

struct Jelly {
  posScale: vec4f,
  /** phase, tilt x, tilt z, hue */
  params: vec4f,
};
@group(1) @binding(0) var<storage, read> jellies: array<Jelly>;

struct VIn {
  @location(0) position: vec4f,
  @location(1) normal: vec4f,
  @location(2) uv: vec4f,
  @builtin(instance_index) instance: u32,
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec4f,
  @location(3) @interpolate(flat) instance: u32,
};

/** Contraction curve: quick squeeze, slow relax. */
fn pulse(phase: f32) -> f32 {
  let t = fract(phase);
  return select(1.0 - (t - 0.25) / 0.75, t / 0.25, t < 0.25);
}

@vertex
fn vs(v: VIn) -> VOut {
  let j = jellies[v.instance];
  let part = u32(v.uv.w + 0.5);
  let squeeze = pulse(j.params.x);
  var p = v.position.xyz;
  if (part <= ${Part.InnerBell}u) {
    let rim = v.uv.z;
    p.x *= 1.0 - squeeze * 0.22 * rim;
    p.z *= 1.0 - squeeze * 0.22 * rim;
    p.y *= 1.0 + squeeze * 0.12;
  } else {
    // Arms and tentacles follow the bell with a lag that grows along them.
    let along = v.uv.y;
    let lag = pulse(j.params.x - along * 0.35);
    let radial = normalize(vec3f(p.x, 0.0, p.z) + 1e-4);
    p -= radial * lag * 0.15 * (1.0 - along * 0.5);
    p += vec3f(
      sin(frame.time * 0.7 + along * 3.0 + j.params.x * 2.0),
      0.0,
      cos(frame.time * 0.6 + along * 2.5 + j.params.x),
    ) * along * along * 0.25;
    p.y += along * lag * 0.12;
  }
  // Gentle tilt.
  let tilt = vec3f(j.params.y, 0.0, j.params.z);
  p += vec3f(tilt.x * p.y, 0.0, tilt.z * p.y);
  let world = p * j.posScale.w + j.posScale.xyz;
  var o: VOut;
  o.pos = frame.viewProj * vec4f(world, 1.0);
  o.world = world;
  o.normal = normalize(v.normal.xyz);
  o.uv = v.uv;
  o.instance = v.instance;
  return o;
}

@fragment
fn fs(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let j = jellies[i.instance];
  let part = u32(i.uv.w + 0.5);
  var n = normalize(i.normal);
  if (!front) {
    n = -n;
  }
  let V = normalize(frame.camPos - i.world);
  let NoV = abs(dot(n, V));
  let fres = pow(1.0 - NoV, 2.5);
  let hue = palette(j.params.w, vec3f(0.6, 0.6, 0.7), vec3f(0.35), vec3f(1.0), vec3f(0.55, 0.7, 0.9));

  // Light: sun scattered through the gel plus ambient, glow at the rim and in the gonads.
  let sun = sunAtDepth(i.world.y) * (0.25 + waterPhase(dot(-V, frame.sunDir)) * 2.0);
  let amb = ambientAtDepth(i.world.y);
  var col = (sun * 0.35 + amb * 0.9) * mix(vec3f(0.85, 0.9, 1.0), hue, 0.4);
  var alpha = 0.06 + fres * 0.5;
  var glow = vec3f(0.0);
  if (part <= ${Part.InnerBell}u) {
    let rimGlow = smoothstep(0.8, 1.0, i.uv.y);
    // Four-leaf gonad pattern near the apex.
    let a = i.uv.x * 6.2831853;
    let leaf = smoothstep(0.55, 0.9, abs(cos(a * 2.0))) * smoothstep(0.55, 0.25, i.uv.y) * smoothstep(0.1, 0.25, i.uv.y);
    col = mix(col, hue * (sun * 0.3 + amb), leaf * 0.6);
    alpha += leaf * 0.25 + rimGlow * 0.2;
    glow = hue * (rimGlow * 1.2 + leaf * 0.3) * (0.6 + 0.4 * pulse(j.params.x));
  } else if (part == ${Part.Arm}u) {
    col *= hue * 1.2;
    alpha = 0.18 + fres * 0.35;
    glow = hue * 0.15;
  } else {
    alpha = 0.35 * (1.0 - i.uv.y * 0.7);
    glow = hue * 0.4 * (1.0 - i.uv.y);
  }
  let lit = applyWater(col + glow * 0.4, i.world);
  let dist = length(i.world - frame.camPos);
  // Fade out right in front of the lens instead of clipping through it.
  let a = clamp(alpha, 0.0, 0.9) * exp(-dist * 0.03) * smoothstep(0.35, 1.2, dist);
  return vec4f(lit * a, a);
}
`;

export type JellyfishSystem = RenderSystem & {
  /** Live CPU-side jelly positions and sizes (for the following camera). */
  jellies(): readonly {pos: readonly number[]; scale: number}[];
};

interface JellyState {
  pos: [number, number, number];
  scale: number;
  phase: number;
  rate: number;
  hue: number;
  vel: [number, number, number];
  wob: number;
  /** Depth this one hovers around, and how fast it wanders from it. */
  home: number;
  wander: number;
}

export async function createJellyfish(
  renderer: Renderer,
  ctx: GenContext,
): Promise<JellyfishSystem> {
  const device = renderer.device;
  const rng = ctx.rng('jellyfish');
  const hi = ctx.quality.detail;
  // Blooms of jellies drifting through the whole basin.
  const count = Math.max(
    40,
    Math.round(rng.int(300, 480) * Math.pow(ctx.quality.density, 1.5)),
  );

  const variants: {patches: Patch[]; radius: number}[] = [];
  const makeVariant = () => {
    const patches: Patch[] = [
      {
        segU: hi ? 48 : 24,
        segV: hi ? 14 : 8,
        params: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Part.Bell],
      },
      {
        segU: hi ? 32 : 16,
        segV: hi ? 8 : 5,
        params: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Part.InnerBell],
      },
    ];
    for (let a = 0; a < 4; a++) {
      patches.push({
        segU: 3,
        segV: hi ? 20 : 10,
        params: [
          (a / 4) * Math.PI * 2 + 0.4,
          rng.range(0.6, 1.2),
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
          0,
          0,
          Part.Arm,
        ],
      });
    }
    const tentacles = hi ? 24 : 12;
    for (let t = 0; t < tentacles; t++) {
      patches.push({
        segU: 3,
        segV: hi ? 16 : 8,
        params: [
          (t / tentacles) * Math.PI * 2,
          rng.range(0.8, 2.2),
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
          0,
          0,
          Part.Tentacle,
        ],
      });
    }
    return {patches, radius: 2};
  };
  variants.push(makeVariant());
  // Variant 1: the same jelly, coarsely tessellated, for distant ones.
  const lod = withLodChain(variants, () => true, [0.35]);
  const mesh = await buildMesh(
    device,
    'jellyfish',
    meshWgsl,
    lod.variants,
    rng.nextU32(),
  );

  const center = ctx.nav.o.center;
  const R = ctx.desc.terrain.basinRadius;
  const ceiling = ctx.nav.ceiling();
  const hueBase = rng.float();
  const jellies: JellyState[] = [];
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * R * 0.8;
    const x = center[0] + Math.cos(a) * r;
    const z = center[1] + Math.sin(a) * r;
    const g = ctx.terrain.heightAt(x, z);
    // Spread through the water column, a little denser in mid-water.
    const t = (rng.float() + rng.float()) * 0.5;
    const home = g + 3 + t * Math.max(0.5, ceiling - 0.5 - (g + 3));
    jellies.push({
      pos: [x, home, z],
      home,
      wander: rng.range(0.6, 2.2),
      scale: rng.range(0.12, 0.3),
      phase: rng.float(),
      rate: rng.range(0.5, 0.9),
      hue: (hueBase + rng.range(-0.12, 0.12) + 1) % 1,
      vel: [rng.range(-0.05, 0.05), 0, rng.range(-0.05, 0.05)],
      wob: rng.range(0, 10),
    });
  }

  const data = new Float32Array(count * 8);
  const buf = device.createBuffer({
    label: 'jellyfish:instances',
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const module = createShader(device, 'jellyfish:shader', renderWgsl);
  const localLayout = device.createBindGroupLayout({
    label: 'jellyfish:local-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {type: 'read-only-storage'},
      },
    ],
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'jellyfish:pipeline',
    layout: device.createPipelineLayout({
      label: 'jellyfish:pipeline-layout',
      bindGroupLayouts: [renderer.globals.layout, localLayout],
    }),
    vertex: {module, entryPoint: 'vs', buffers: [vertexLayout]},
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        {
          format: HDR_FORMAT,
          blend: {
            color: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'},
          },
        },
      ],
    },
    primitive: {topology: 'triangle-list', cullMode: 'none'},
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: 'greater',
    },
  });
  const bindGroup = device.createBindGroup({
    label: 'jellyfish:bind-group',
    layout: localLayout,
    entries: [{binding: 0, resource: {buffer: buf}}],
  });

  let nearCount = 0;
  let farCount = 0;
  const planes = new Float32Array(16);

  // Rocks, in a coarse grid: a jelly only ever looks at the handful near it.
  const ROCK_CELL = 12;
  const rocks = new Map<string, NavSphere[]>();
  const rockKey = (x: number, z: number) =>
    `${Math.floor(x / ROCK_CELL)},${Math.floor(z / ROCK_CELL)}`;
  for (const o of ctx.obstacles) {
    // Into every cell the sphere reaches, by cell index rather than by
    // stepping, so the far edge is never skipped.
    const r = o.radius + 3;
    const x0 = Math.floor((o.center[0] - r) / ROCK_CELL);
    const x1 = Math.floor((o.center[0] + r) / ROCK_CELL);
    const z0 = Math.floor((o.center[2] - r) / ROCK_CELL);
    const z1 = Math.floor((o.center[2] + r) / ROCK_CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = `${ix},${iz}`;
        const list = rocks.get(k);
        if (list) {
          list.push(o);
        } else {
          rocks.set(k, [o]);
        }
      }
    }
  }
  return {
    name: 'jellyfish',
    jellies: () => jellies,
    update(fc: FrameContext) {
      const dt = fc.dt;
      const view = fc.view;
      const m = view.viewProj;
      sidePlanes(m, planes);
      nearCount = 0;
      farCount = 0;
      jellies.forEach(j => {
        j.phase += dt * j.rate;
        // Each contraction thrusts upward and it sinks back between them, so
        // over a cycle it holds its depth instead of everything climbing to
        // the surface and collecting there in one layer. A gentle pull back
        // to its own depth keeps the spread through the water column.
        const thrust = j.phase % 1 < 0.25 ? 0.35 : -0.12;
        const home = j.home + Math.sin(fc.time * 0.04 + j.wob) * j.wander;
        j.vel[1] += (thrust + (home - j.pos[1]) * 0.05 - j.vel[1] * 0.8) * dt;
        j.vel[0] += Math.sin(fc.time * 0.05 + j.wob) * 0.004 * dt;
        j.vel[2] += Math.cos(fc.time * 0.04 + j.wob) * 0.004 * dt;
        j.pos[0] += j.vel[0] * dt;
        j.pos[1] += j.vel[1] * dt;
        j.pos[2] += j.vel[2] * dt;
        // Rocks and walls. A jelly has no eyes and no hurry: it drifts clear
        // rather than swerving, so the push is small and always outward.
        for (const o of rocks.get(rockKey(j.pos[0], j.pos[2])) ?? []) {
          const rx = j.pos[0] - o.center[0];
          const ry = j.pos[1] - o.center[1];
          const rz = j.pos[2] - o.center[2];
          const rd = Math.hypot(rx, ry, rz);
          const want = o.radius + j.scale * 2 + 0.4;
          if (rd < want && rd > 1e-3) {
            const push = ((want - rd) / want) * dt;
            j.vel[0] += (rx / rd) * push * 1.4;
            j.vel[1] += (ry / rd) * push * 0.6;
            j.vel[2] += (rz / rd) * push * 1.4;
          }
        }
        // Steep ground pushes them off it, down the slope, before they reach
        // the floor bounce below.
        const gh = ctx.terrain.groundAt(j.pos[0], j.pos[2]);
        if (j.pos[1] - gh < 4 + j.scale * 3) {
          const n = ctx.terrain.normalAt(j.pos[0], j.pos[2]);
          const steep = Math.hypot(n[0], n[2]);
          if (steep > 0.35) {
            const k = (dt * steep) / Math.max(steep, 1e-3);
            j.vel[0] += n[0] * k * 0.5;
            j.vel[2] += n[2] * k * 0.5;
          }
        }

        // Drift gently away from the camera so it doesn't swim into them.
        const cam = fc.view.camPos;
        const ax = j.pos[0] - cam[0];
        const ay = j.pos[1] - cam[1];
        const az = j.pos[2] - cam[2];
        const d = Math.hypot(ax, ay, az);
        const personal = 1.5 + j.scale * 3;
        if (d < personal && d > 1e-3) {
          const push = ((personal - d) / personal) * 0.6 * dt;
          j.vel[0] += (ax / d) * push;
          j.vel[1] += (ay / d) * push;
          j.vel[2] += (az / d) * push;
          j.pos[0] += (ax / d) * (personal - d) * Math.min(1, dt * 0.5);
          j.pos[2] += (az / d) * (personal - d) * Math.min(1, dt * 0.5);
        }
        j.vel[0] *= 1 - Math.min(1, dt * 0.1);
        j.vel[2] *= 1 - Math.min(1, dt * 0.1);
        const g = ctx.terrain.groundAt(j.pos[0], j.pos[2]);
        if (j.pos[1] > ceiling) {
          j.vel[1] = -0.1;
        }
        if (j.pos[1] < g + 2) {
          j.vel[1] = 0.1;
        }
        const tx = Math.sin(fc.time * 0.3 + j.wob) * 0.15;
        const tz = Math.cos(fc.time * 0.25 + j.wob) * 0.15;
        // Cull to the view; near ones fill from the front of the buffer, far
        // (coarse) ones from the back.
        const [x, y, z] = j.pos;
        const rad = j.scale * 2.5;
        const dist = Math.hypot(x - cam[0], y - cam[1], z - cam[2]);
        if (dist > view.maxDistance + rad) {
          return;
        }
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (cw < -rad || !sphereInside(planes, x, y, z, rad)) {
          return;
        }
        const near = (rad * view.focalPx) / Math.max(dist, 0.1) > 60;
        const slot = near ? nearCount++ : count - 1 - farCount++;
        data.set([x, y, z, j.scale, j.phase, tx, tz, j.hue], slot * 8);
      });
      device.queue.writeBuffer(buf, 0, data);
    },
    drawTransparent(pass) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, bindGroup);
      pass.setVertexBuffer(0, mesh.vertexBuffer);
      pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
      const full = mesh.variants[0];
      const coarse = mesh.variants[lod.chains[0][1]];
      if (nearCount) {
        pass.drawIndexed(full.indexCount, nearCount, full.firstIndex, 0, 0);
      }
      if (farCount) {
        pass.drawIndexed(
          coarse.indexCount,
          farCount,
          coarse.firstIndex,
          0,
          count - farCount,
        );
      }
    },
  };
}
