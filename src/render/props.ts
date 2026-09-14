// Instanced rendering of generated meshes ("props": rocks, coral, shells...).
//
// A prop kind supplies a built mesh, instances sorted by variant, and WGSL
// hooks: `deform()` animates vertices in object space (sway, pulse) and
// `material()` returns the surface description for lighting.

import {createShader} from '../gpu/device.ts';
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

@vertex
fn vs(v: VIn) -> VOut {
  let inst = instances[v.instance];
  let d = deform(v.position.xyz, v.normal.xyz, v.uv, inst, frame.time);
  let dPrev = deform(v.position.xyz, v.normal.xyz, v.uv, inst, frame.time - frame.misc.x);
  let s = inst.posScale.w;
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
  let s = material(i, n, inst);
  let lit = shadeSurface(s, i.world, -1.0);
  var o: FOut;
  o.color = vec4f(applyWater(lit, i.world), 1.0);
  o.velocity = (i.curClip.xy / i.curClip.w - i.prevClip.xy / i.prevClip.w) * vec2f(0.5, -0.5);
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
  let world = quatRotate(inst.rot, d.pos * inst.posScale.w) + inst.posScale.xyz;
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
   * Level of detail: `low[v]` is a cheaper stand-in variant for variant `v`
   * (or -1), used beyond `distance` metres and always in the shadow pass.
   */
  lod?: {low: number[]; distance: number};
}

export function packInstances(list: Instance[]): {
  data: Float32Array;
  ranges: {first: number; count: number}[];
} {
  const sorted = [...list].sort((a, b) => a.variant - b.variant);
  const data = new Float32Array(
    Math.max(1, sorted.length) * (INSTANCE_SIZE / 4),
  );
  const ranges: {first: number; count: number}[] = [];
  sorted.forEach((inst, i) => {
    const o = i * 16;
    data.set(
      [...inst.pos, inst.scale, ...inst.rot, ...inst.color, ...inst.params],
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
  const {data, ranges} = packInstances(o.instances);
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

  const lowOf = ranges.map((_, v) => o.lod?.low[v] ?? -1);
  const lodD2 = (o.lod?.distance ?? Infinity) ** 2;
  // Instances drawn with variant w: its own, plus those of variants whose
  // low-detail stand-in is w.
  const sourcesOf = ranges.map((_, w) => [
    w,
    ...lowOf.flatMap((l, u) => (l === w && u !== w ? [u] : [])),
  ]);

  const cull = (view: CullView) => {
    const m = view.viewProj;
    const sm = view.shadowViewProj;
    const cp = view.camPos;
    const maxD2 = view.maxDistance * view.maxDistance;
    let cursor = 0;
    // Camera pass.
    for (let w = 0; w < variantCount; w++) {
      camRanges[w].first = cursor;
      for (const v of sourcesOf[w]) {
        const r = ranges[v];
        if (!r) {
          continue;
        }
        const own = v === w;
        const hasLow = lowOf[v] >= 0 && lowOf[v] !== v;
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
          if (d2 > maxD2 + rad * rad * 4) {
            continue;
          }
          // Near instances draw at full detail, far ones as their stand-in.
          const far = d2 > lodD2;
          if (own ? hasLow && far : !far) {
            continue;
          }
          // Clip-space sphere test against the side planes (w = distance ahead).
          const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
          const pad = rad * 1.5;
          if (
            cw < -pad ||
            cx > cw * 1.05 + pad * 1.2 ||
            cx < -cw * 1.05 - pad * 1.2 ||
            cy > cw * 1.05 + pad * 1.2 ||
            cy < -cw * 1.05 - pad * 1.2
          ) {
            continue;
          }
          visible.set(data.subarray(b, b + FLOATS), cursor * FLOATS);
          cursor++;
        }
      }
      camRanges[w].count = cursor - camRanges[w].first;
    }
    // Shadow pass: inside the orthographic shadow box, at low detail.
    for (let w = 0; w < variantCount; w++) {
      shadowRanges[w].first = cursor;
      if (castShadows) {
        for (const v of sourcesOf[w]) {
          const r = ranges[v];
          if (!r || (v === w && lowOf[v] >= 0 && lowOf[v] !== v)) {
            continue;
          }
          for (let i = r.first; i < r.first + r.count; i++) {
            const b = i * FLOATS;
            const x = data[b];
            const y = data[b + 1];
            const z = data[b + 2];
            const sx = sm[0] * x + sm[4] * y + sm[8] * z + sm[12];
            const sy = sm[1] * x + sm[5] * y + sm[9] * z + sm[13];
            const pad = radiusOf[i] * Math.abs(sm[0]) * 1.5;
            if (Math.abs(sx) > 1 + pad || Math.abs(sy) > 1 + pad) {
              continue;
            }
            visible.set(data.subarray(b, b + FLOATS), cursor * FLOATS);
            cursor++;
          }
        }
      }
      shadowRanges[w].count = cursor - shadowRanges[w].first;
    }
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
