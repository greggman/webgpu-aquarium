// Instanced rendering of generated meshes ("props": rocks, coral, shells...).
//
// A prop kind supplies a built mesh, instances sorted by variant, and WGSL
// hooks: `deform()` animates vertices in object space (sway, pulse) and
// `material()` returns the surface description for lighting.

import {createShader} from '../gpu/device.ts';
import {sidePlanes, sphereInside} from './frustum.ts';
import {defineStruct} from '../gpu/structs.ts';
import {surfaceLib} from '../shaders/index.ts';
import {vertexLayout, type BuiltMesh} from '../gen/meshgen.ts';
import {
  DEPTH_FORMAT,
  HDR_FORMAT,
  VELOCITY_FORMAT,
  type CullView,
  type Renderer,
  type RenderSystem,
} from './renderer.ts';

export const InstanceStruct = defineStruct('Instance', {
  /** xyz position, w uniform scale */
  posScale: 'vec4f',
  /** rotation quaternion (x, y, z, w) */
  rot: 'vec4f',
  /** tint rgb, a: free parameter */
  color: 'vec4f',
  /** free parameters (phase, sway strength, ...) */
  params: 'vec4f',
  /** x: distance at which the instance has fully faded out (detail fade), yzw unused */
  fade: 'vec4f',
});
export const INSTANCE_SIZE = InstanceStruct.size;

export interface Instance {
  pos: [number, number, number];
  scale: number;
  rot: [number, number, number, number];
  color: [number, number, number, number];
  params: [number, number, number, number];
  variant: number;
}

export const propCommonWgsl = /* wgsl */ `
${surfaceLib}
${InstanceStruct.wgsl}
@group(1) @binding(0) var<storage, read> instances: array<Instance>;

fn quatRotate(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

struct Deformed {
  pos: vec3f,
  normal: vec3f,
};

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
  @location(3) local: vec3f,
  @location(4) @interpolate(flat) instance: u32,
  @location(5) aoMat: vec2f,
  @location(6) curClip: vec4f,
  @location(7) prevClip: vec4f,
};
`;

const propShader = (kindWgsl: string) => /* wgsl */ `
${propCommonWgsl}
${kindWgsl}

fn detailFade(inst: Instance) -> f32 {
  let end = inst.fade.x;
  return smoothstep(end, end * 0.78, distance(inst.posScale.xyz, frame.camPos));
}

@vertex
fn vs(v: VIn) -> VOut {
  let inst = instances[v.instance];
  let d = deform(v.position.xyz, v.normal.xyz, v.uv, inst, frame.time);
  let dPrev = deform(v.position.xyz, v.normal.xyz, v.uv, inst, frame.time - frame.misc.x);
  // Detail fade: small things shrink away into the seabed before they're
  // culled, instead of popping.
  let s = inst.posScale.w * detailFade(inst);
  let world = quatRotate(inst.rot, d.pos * s) + inst.posScale.xyz;
  let prevWorld = quatRotate(inst.rot, dPrev.pos * s) + inst.posScale.xyz;
  var o: VOut;
  o.pos = frame.viewProj * vec4f(world, 1.0);
  o.world = world;
  o.normal = quatRotate(inst.rot, d.normal);
  o.uv = v.uv;
  o.local = v.position.xyz;
  o.instance = v.instance;
  o.aoMat = vec2f(v.position.w, v.normal.w);
  o.curClip = frame.viewProjNoJitter * vec4f(world, 1.0);
  o.prevClip = frame.prevViewProjNoJitter * vec4f(prevWorld, 1.0);
  return o;
}

struct FOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
};

@fragment
fn fs(i: VOut, @builtin(front_facing) front: bool) -> FOut {
  var n = normalize(i.normal);
  if (!front) {
    n = -n;
  }
  let inst = instances[i.instance];
  var s = material(i, n, inst);
  // Buried base: the lowest few centimetres pick up sediment and darken, with
  // an uneven edge, so props sit in the seabed rather than on it.
  let uvT = i.world.xz / frame.terrain.x + 0.5;
  let ground = textureSampleLevel(tTerrain, sLinearClamp, uvT, 0.0).r;
  let sandy = 1.0 - textureSampleLevel(tTerrainMask, sLinearClamp, uvT, 0.0).r;
  let edge = 0.04 + 0.05 * textureSampleLevel(tDetail, sLinearRepeat, i.world.xz * 0.9, 0.0).r;
  let buried = smoothstep(edge, 0.0, i.world.y - ground);
  s.albedo = mix(s.albedo, mix(s.albedo * 0.6, vec3f(0.5, 0.45, 0.36), sandy), buried * 0.85);
  s.ao *= mix(1.0, 0.6, buried);
  s.albedo = setDressing(s.albedo);
  let lit = recede(shadeSurface(s, i.world, -1.0), i.world);
  var o: FOut;
  o.color = vec4f(applyWater(lit, i.world), 1.0);
  o.velocity = screenVelocity(i.curClip, i.prevClip);
  return o;
}

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec4f,
  @location(1) local: vec3f,
  @location(2) @interpolate(flat) instance: u32,
};

@vertex
fn vsShadow(v: VIn) -> SOut {
  let inst = instances[v.instance];
  let d = deform(v.position.xyz, v.normal.xyz, v.uv, inst, frame.time);
  let world = quatRotate(inst.rot, d.pos * inst.posScale.w * detailFade(inst)) + inst.posScale.xyz;
  var o: SOut;
  o.pos = frame.shadowViewProj * vec4f(world, 1.0);
  o.uv = v.uv;
  o.local = v.position.xyz;
  o.instance = v.instance;
  return o;
}

@fragment
fn fsShadow(i: SOut) {
  if (alphaMask(i.uv, i.local, instances[i.instance]) < 0.5) {
    discard;
  }
}
`;

export interface PropKindOptions {
  name: string;
  mesh: BuiltMesh;
  instances: Instance[];
  /**
   * WGSL defining:
   *   fn deform(p: vec3f, n: vec3f, uv: vec4f, inst: Instance, t: f32) -> Deformed
   *   fn material(i: VOut, n: vec3f, inst: Instance) -> Surface
   *   fn alphaMask(uv: vec4f, local: vec3f, inst: Instance) -> f32   (only if alphaTest)
   */
  wgsl: string;
  alphaTest?: boolean;
  castShadows?: boolean;
  cullMode?: GPUCullMode;
  /**
   * Level of detail: `chains[v]` lists variant `v` and its cheaper stand-ins,
   * finest first. The level is picked by projected size: the finest while the
   * bounding radius covers more than `pixels[0]` pixels, the next above
   * `pixels[1]`, and so on. Shadows use at least the second level.
   */
  lod?: {chains: number[][]; pixels?: number[]};
  /** Instances smaller than this (world radius) don't cast shadows. */
  shadowMinRadius?: number;
  /**
   * Detail fade: distance (m) by which an instance has shrunk away and is no
   * longer drawn, typically proportional to its size. Omit to draw to the
   * view distance.
   */
  fadeDistance?: (inst: Instance, radius: number) => number;
  /**
   * Contact occlusion footprint as multiples of the instance's bounding
   * radius (see render/contact.ts); omit for things that don't block the sky.
   */
  contact?: {radius: number; height: number};
}

export function packInstances(
  list: Instance[],
  fadeOf: (inst: Instance) => number = () => 1e6,
): {
  data: Float32Array;
  ranges: {first: number; count: number}[];
} {
  const sorted = [...list].sort((a, b) => a.variant - b.variant);
  const data = new Float32Array(
    Math.max(1, sorted.length) * (INSTANCE_SIZE / 4),
  );
  const ranges: {first: number; count: number}[] = [];
  sorted.forEach((inst, i) => {
    const o = i * (INSTANCE_SIZE / 4);
    data.set(
      [
        ...inst.pos,
        inst.scale,
        ...inst.rot,
        ...inst.color,
        ...inst.params,
        fadeOf(inst),
        0,
        0,
        0,
      ],
      o,
    );
    while (ranges.length <= inst.variant) {
      ranges.push({first: i, count: 0});
    }
    ranges[inst.variant].count++;
  });
  // Fix up `first` for variants that had no instances before later ones.
  let cursor = 0;
  for (const r of ranges) {
    r.first = cursor;
    cursor += r.count;
  }
  return {data, ranges};
}

export async function createPropKind(
  renderer: Renderer,
  o: PropKindOptions,
): Promise<RenderSystem> {
  const device = renderer.device;
  // Recorded for the tests, which compare how much life a change puts in the
  // world; counting what a single view draws only measures the view.
  const counts = (window.__aquarium.propCounts ??= {}) as Record<
    string,
    number
  >;
  counts[o.name] = (counts[o.name] ?? 0) + o.instances.length;
  if (o.contact) {
    for (const inst of o.instances) {
      const r = (o.mesh.variants[inst.variant]?.radius ?? 1) * inst.scale;
      renderer.footprints.push({
        x: inst.pos[0],
        z: inst.pos[2],
        radius: r * o.contact.radius,
        height: r * o.contact.height,
      });
    }
  }
  const kindWgsl = o.alphaTest
    ? o.wgsl
    : `${o.wgsl}\nfn alphaMask(uv: vec4f, local: vec3f, inst: Instance) -> f32 { return 1.0; }`;
  const module = createShader(device, `${o.name}:shader`, propShader(kindWgsl));
  const localLayout = device.createBindGroupLayout({
    label: `${o.name}:local-bgl`,
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {type: 'read-only-storage', minBindingSize: INSTANCE_SIZE},
      },
    ],
  });
  const layout = device.createPipelineLayout({
    label: `${o.name}:pipeline-layout`,
    bindGroupLayouts: [renderer.globals.layout, localLayout],
  });
  const cullMode = o.cullMode ?? 'none';
  const [pipeline, shadowPipeline] = await Promise.all([
    device.createRenderPipelineAsync({
      label: `${o.name}:pipeline`,
      layout,
      vertex: {module, entryPoint: 'vs', buffers: [vertexLayout]},
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{format: HDR_FORMAT}, {format: VELOCITY_FORMAT}],
      },
      primitive: {topology: 'triangle-list', cullMode},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    }),
    device.createRenderPipelineAsync({
      label: `${o.name}:shadow-pipeline`,
      layout,
      vertex: {module, entryPoint: 'vsShadow', buffers: [vertexLayout]},
      fragment: o.alphaTest
        ? {module, entryPoint: 'fsShadow', targets: []}
        : undefined,
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    }),
  ]);

  // Instances are kept on the CPU, sorted by variant. Each frame the ones the
  // camera or the shadow map can see are copied into the GPU buffer: first the
  // camera-visible set, then the shadow-visible set, each grouped by variant.
  const {data, ranges} = packInstances(o.instances, inst =>
    o.fadeDistance
      ? o.fadeDistance(
          inst,
          (o.mesh.variants[inst.variant]?.radius ?? 1) * inst.scale,
        )
      : 1e6,
  );
  // Every mesh variant gets a range (LOD stand-ins may have no instances of their own).
  while (ranges.length < o.mesh.variants.length) {
    ranges.push({first: o.instances.length, count: 0});
  }
  const FLOATS = INSTANCE_SIZE / 4;
  const count = Math.max(1, o.instances.length);
  const variantOf = new Uint16Array(count);
  const radiusOf = new Float32Array(count);
  ranges.forEach((r, v) => {
    const vr = o.mesh.variants[v]?.radius ?? 1;
    for (let i = r.first; i < r.first + r.count; i++) {
      variantOf[i] = v;
      radiusOf[i] = vr * data[i * FLOATS + 3];
    }
  });
  const visible = new Float32Array(count * 2 * FLOATS);
  const instanceBuf = device.createBuffer({
    label: `${o.name}:instances`,
    size: visible.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    label: `${o.name}:bind-group`,
    layout: localLayout,
    entries: [{binding: 0, resource: {buffer: instanceBuf}}],
  });
  const variantCount = ranges.length;
  const camRanges = ranges.map(() => ({first: 0, count: 0}));
  const shadowRanges = ranges.map(() => ({first: 0, count: 0}));
  const castShadows = o.castShadows !== false;
  const shadowMinRadius = o.shadowMinRadius ?? 0;

  // Level-of-detail chains (a variant without one is its own only level).
  const chains = ranges.map((_, v) => o.lod?.chains[v] ?? [v]);
  const pixels = o.lod?.pixels ?? [90, 28, 0];
  // Instances are sorted into per-drawn-variant scratch regions, then packed.
  const capacity = new Array<number>(variantCount).fill(0);
  ranges.forEach((r, v) => {
    for (const w of new Set(chains[v])) {
      capacity[w] += r.count;
    }
  });
  const scratchOffset: number[] = [];
  let scratchSize = 0;
  for (let w = 0; w < variantCount; w++) {
    scratchOffset.push(scratchSize);
    scratchSize += capacity[w];
  }
  const camScratch = new Float32Array(Math.max(1, scratchSize) * FLOATS);
  const shadowScratch = new Float32Array(Math.max(1, scratchSize) * FLOATS);
  const camFill = new Uint32Array(variantCount);
  const shadowFill = new Uint32Array(variantCount);

  const levelFor = (px: number, chainLength: number) => {
    let level = 0;
    while (
      level < chainLength - 1 &&
      level < pixels.length &&
      px < pixels[level]
    ) {
      level++;
    }
    return level;
  };

  const camPlanes = new Float32Array(16);
  const shadowPlanes = new Float32Array(16);

  const cull = (view: CullView) => {
    const m = view.viewProj;
    sidePlanes(view.viewProj, camPlanes);
    sidePlanes(view.shadowViewProj, shadowPlanes);
    const cp = view.camPos;
    const focal = view.focalPx;
    const maxD2 = view.maxDistance * view.maxDistance;
    camFill.fill(0);
    shadowFill.fill(0);
    for (let v = 0; v < variantCount; v++) {
      const r = ranges[v];
      if (!r || !r.count) {
        continue;
      }
      const chain = chains[v];
      for (let i = r.first; i < r.first + r.count; i++) {
        const b = i * FLOATS;
        const x = data[b];
        const y = data[b + 1];
        const z = data[b + 2];
        const rad = radiusOf[i];
        const dx = x - cp[0];
        const dy = y - cp[1];
        const dz = z - cp[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        // Faded out entirely: skip for the camera and the shadow map alike.
        const fadeEnd = data[b + 16];
        if (d2 > fadeEnd * fadeEnd) {
          continue;
        }
        const px = (rad * focal) / Math.max(Math.sqrt(d2), 0.1);
        const level = levelFor(px, chain.length);

        // Camera: distance, then the four side planes (w is the distance
        // along the view direction, so it also rejects what is behind).
        if (d2 <= maxD2 + rad * rad * 4) {
          const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
          if (cw > -rad && sphereInside(camPlanes, x, y, z, rad)) {
            const w = chain[level];
            camScratch.set(
              data.subarray(b, b + FLOATS),
              (scratchOffset[w] + camFill[w]++) * FLOATS,
            );
          }
        }

        // Shadow: inside the orthographic shadow box, at the coarsest level
        // (the shadow map is soft; silhouettes at a few cm per texel).
        // Small casters stop shadowing a little before they fade.
        if (
          castShadows &&
          rad >= shadowMinRadius &&
          d2 < fadeEnd * fadeEnd * 0.6
        ) {
          if (sphereInside(shadowPlanes, x, y, z, rad)) {
            const w = chain[chain.length - 1];
            shadowScratch.set(
              data.subarray(b, b + FLOATS),
              (scratchOffset[w] + shadowFill[w]++) * FLOATS,
            );
          }
        }
      }
    }
    let cursor = 0;
    const pack = (
      scratch: Float32Array,
      fill: Uint32Array,
      out: {first: number; count: number}[],
    ) => {
      for (let w = 0; w < variantCount; w++) {
        out[w].first = cursor;
        out[w].count = fill[w];
        if (fill[w]) {
          const start = scratchOffset[w] * FLOATS;
          visible.set(
            scratch.subarray(start, start + fill[w] * FLOATS),
            cursor * FLOATS,
          );
          cursor += fill[w];
        }
      }
    };
    pack(camScratch, camFill, camRanges);
    pack(shadowScratch, shadowFill, shadowRanges);
    if (cursor) {
      device.queue.writeBuffer(
        instanceBuf,
        0,
        visible.buffer,
        0,
        cursor * INSTANCE_SIZE,
      );
    }
  };

  const draw = (
    pass: GPURenderPassEncoder,
    p: GPURenderPipeline,
    list: {first: number; count: number}[],
  ) => {
    if (!o.instances.length) {
      return;
    }
    pass.setPipeline(p);
    pass.setBindGroup(1, bindGroup);
    pass.setVertexBuffer(0, o.mesh.vertexBuffer);
    pass.setIndexBuffer(o.mesh.indexBuffer, 'uint32');
    list.forEach((r, v) => {
      const mv = o.mesh.variants[v];
      if (r.count && mv) {
        pass.drawIndexed(mv.indexCount, r.count, mv.firstIndex, 0, r.first);
      }
    });
  };

  return {
    name: o.name,
    update: ctx => cull(ctx.view),
    drawOpaque: pass => draw(pass, pipeline, camRanges),
    drawShadow: castShadows
      ? pass => draw(pass, shadowPipeline, shadowRanges)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Quaternion helpers for placement.

export type Quat = [number, number, number, number];

export function quatAxisAngle(
  axis: [number, number, number],
  angle: number,
): Quat {
  const s = Math.sin(angle / 2);
  const l = Math.hypot(...axis) || 1;
  return [
    (axis[0] / l) * s,
    (axis[1] / l) * s,
    (axis[2] / l) * s,
    Math.cos(angle / 2),
  ];
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Rotation taking +Y to `up`, followed by a yaw around `up`. */
export function quatUpYaw(up: [number, number, number], yaw: number): Quat {
  const l = Math.hypot(...up) || 1;
  const u: [number, number, number] = [up[0] / l, up[1] / l, up[2] / l];
  const yawQ = quatAxisAngle([0, 1, 0], yaw);
  const dot = u[1];
  if (dot > 0.9999) {
    return yawQ;
  }
  // Axis = Y x up
  const axis: [number, number, number] = [u[2], 0, -u[0]];
  const tilt = quatAxisAngle(axis, Math.acos(Math.max(-1, Math.min(1, dot))));
  return quatMul(tilt, yawQ);
}
