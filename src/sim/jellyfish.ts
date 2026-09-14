// Jellyfish: translucent pulsing bells with frilled oral arms and trailing
// tentacles, softly bioluminescent. Drawn in the transparent pass.

import {createShader} from '../gpu/device.ts';
import {buildMesh, vertexLayout, type Patch} from '../gen/meshgen.ts';
import {surfaceLib} from '../shaders/index.ts';
import shapes from '../shaders/shapes.wgsl';
import propsWgsl from '../shaders/props.wgsl';
import {DEPTH_FORMAT, HDR_FORMAT, type FrameContext, type Renderer, type RenderSystem} from '../render/renderer.ts';
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
  let a = clamp(alpha, 0.0, 0.9) * exp(-dist * 0.03);
  return vec4f(lit * a, a);
}
`;

interface JellyState {
  pos: [number, number, number];
  scale: number;
  phase: number;
  rate: number;
  hue: number;
  vel: [number, number, number];
  wob: number;
}

export async function createJellyfish(renderer: Renderer, ctx: GenContext): Promise<RenderSystem> {
  const device = renderer.device;
  const rng = ctx.rng('jellyfish');
  const hi = ctx.quality.tierIndex >= 2;
  const count = Math.max(4, Math.round(rng.int(10, 18) * ctx.quality.density));

  const variants: {patches: Patch[]; radius: number}[] = [];
  const makeVariant = () => {
    const patches: Patch[] = [
      {segU: hi ? 48 : 24, segV: hi ? 14 : 8, params: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Part.Bell]},
      {segU: hi ? 32 : 16, segV: hi ? 8 : 5, params: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Part.InnerBell]},
    ];
    for (let a = 0; a < 4; a++) {
      patches.push({segU: 3, segV: hi ? 20 : 10, params: [(a / 4) * Math.PI * 2 + 0.4, rng.range(0.6, 1.2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Part.Arm]});
    }
    const tentacles = hi ? 24 : 12;
    for (let t = 0; t < tentacles; t++) {
      patches.push({segU: 3, segV: hi ? 16 : 8, params: [(t / tentacles) * Math.PI * 2, rng.range(0.8, 2.2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Part.Tentacle]});
    }
    return {patches, radius: 2};
  };
  variants.push(makeVariant());
  const mesh = await buildMesh(device, 'jellyfish', meshWgsl, variants, rng.nextU32());

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
    jellies.push({
      pos: [x, rng.range(g + 3, ceiling - 0.5), z],
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
    entries: [{binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {type: 'read-only-storage'}}],
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
            color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
            alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'},
          },
        },
      ],
    },
    primitive: {topology: 'triangle-list', cullMode: 'none'},
    depthStencil: {format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater'},
  });
  const bindGroup = device.createBindGroup({
    label: 'jellyfish:bind-group',
    layout: localLayout,
    entries: [{binding: 0, resource: {buffer: buf}}],
  });

  return {
    name: 'jellyfish',
    update(fc: FrameContext) {
      const dt = fc.dt;
      jellies.forEach((j, i) => {
        j.phase += dt * j.rate;
        // Each contraction gives a little upward thrust; they slowly sink between.
        const thrust = (j.phase % 1) < 0.25 ? 0.35 : -0.03;
        j.vel[1] += (thrust - j.vel[1] * 0.8) * dt;
        j.vel[0] += Math.sin(fc.time * 0.05 + j.wob) * 0.004 * dt;
        j.vel[2] += Math.cos(fc.time * 0.04 + j.wob) * 0.004 * dt;
        j.pos[0] += j.vel[0] * dt;
        j.pos[1] += j.vel[1] * dt;
        j.pos[2] += j.vel[2] * dt;
        const g = ctx.terrain.heightAt(j.pos[0], j.pos[2]);
        if (j.pos[1] > ceiling) {
          j.vel[1] = -0.1;
        }
        if (j.pos[1] < g + 2) {
          j.vel[1] = 0.1;
        }
        const tx = Math.sin(fc.time * 0.3 + j.wob) * 0.15;
        const tz = Math.cos(fc.time * 0.25 + j.wob) * 0.15;
        data.set([...j.pos, j.scale, j.phase, tx, tz, j.hue], i * 8);
      });
      device.queue.writeBuffer(buf, 0, data);
    },
    drawTransparent(pass) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, bindGroup);
      pass.setVertexBuffer(0, mesh.vertexBuffer);
      pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
      pass.drawIndexed(mesh.variants[0].indexCount, count, mesh.variants[0].firstIndex, 0, 0);
    },
  };
}
