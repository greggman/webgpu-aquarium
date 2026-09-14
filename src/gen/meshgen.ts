// GPU mesh builder.
//
// Every organic shape (rocks, coral, shells, creatures) is described as a set
// of parametric patches: a (u, v) grid pushed through a WGSL `surface()`
// function. A compute shader evaluates all vertices of all patches of all
// variants in one dispatch, computing normals by finite differences when the
// surface function doesn't supply one. The CPU only builds index lists.

import {createShader} from '../gpu/device.ts';
import {noise} from '../shaders/index.ts';

export const VERTEX_SIZE = 48;

/** Vertex buffer layout shared by all built meshes. */
export const vertexLayout: GPUVertexBufferLayout = {
  arrayStride: VERTEX_SIZE,
  attributes: [
    {shaderLocation: 0, offset: 0, format: 'float32x4'}, // position.xyz, ao
    {shaderLocation: 1, offset: 16, format: 'float32x4'}, // normal.xyz, material
    {shaderLocation: 2, offset: 32, format: 'float32x4'}, // uv.xy, extra.zw
  ],
};

export interface Patch {
  segU: number;
  segV: number;
  /** Up to 16 numbers the surface function reads as p0..p3. */
  params: number[];
}

/**
 * Appends a coarsely tessellated copy of each selected variant (same surface
 * and parameters, so the same shape) for use as a distance LOD. Returns the
 * extended list and, per variant, the index of its stand-in (or -1).
 */
export function withCoarseCopies<T extends {patches: Patch[]}>(
  variants: T[],
  select: (index: number) => boolean,
  factor = 0.4,
): {variants: T[]; low: number[]} {
  const all = [...variants];
  const low = variants.map((v, i) => {
    if (!select(i)) {
      return -1;
    }
    all.push({
      ...v,
      patches: v.patches.map(p => ({
        ...p,
        segU: Math.max(4, Math.round(p.segU * factor)),
        segV: Math.max(2, Math.round(p.segV * factor)),
      })),
    });
    return all.length - 1;
  });
  return {
    variants: all,
    low: [...low, ...all.slice(variants.length).map(() => -1)],
  };
}

export interface VariantRange {
  firstIndex: number;
  indexCount: number;
  /** Bounding radius around the origin, estimated by the caller. */
  radius: number;
}

export interface BuiltMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  variants: VariantRange[];
  vertexCount: number;
}

export const PATCH_WGSL = /* wgsl */ `
struct Patch {
  segs: vec2u,
  vertexOffset: u32,
  variant: u32,
  p0: vec4f,
  p1: vec4f,
  p2: vec4f,
  p3: vec4f,
};

struct SurfacePoint {
  pos: vec3f,
  ao: f32,
  /** If non-zero, used instead of the finite-difference normal. */
  normal: vec3f,
  mat: f32,
  uv: vec4f,
};

fn sp(pos: vec3f, uv: vec4f) -> SurfacePoint {
  return SurfacePoint(pos, 1.0, vec3f(0.0), 0.0, uv);
}
`;

const builderShader = (surfaceWgsl: string) => /* wgsl */ `
${noise}
${PATCH_WGSL}
struct Vertex {
  position: vec4f,
  normal: vec4f,
  uv: vec4f,
};
struct Info { count: u32, seed: u32 };

@group(0) @binding(0) var<storage, read> patches: array<Patch>;
@group(0) @binding(1) var<storage, read> vertexPatch: array<u32>;
@group(0) @binding(2) var<storage, read_write> vertices: array<Vertex>;
@group(0) @binding(3) var<storage, read> aux: array<vec4f>;
@group(0) @binding(4) var<uniform> info: Info;

${surfaceWgsl}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let vid = gid.y * 8192u + gid.x;
  if (gid.x >= 8192u || vid >= info.count) {
    return;
  }
  let patchIndex = vertexPatch[vid];
  let pat = patches[patchIndex];
  noiseSeed = info.seed + pat.variant * 7919u;
  let local = vid - pat.vertexOffset;
  let cols = pat.segs.x + 1u;
  let uv = vec2f(f32(local % cols) / f32(pat.segs.x), f32(local / cols) / f32(pat.segs.y));
  let s = surface(pat, uv);
  var n = s.normal;
  if (dot(n, n) < 0.25) {
    // Central differences, nudged away from the edges and poles.
    let e = 1e-3;
    let c = clamp(uv, vec2f(e * 2.0), vec2f(1.0 - e * 2.0));
    let pu = surface(pat, c + vec2f(e, 0.0)).pos - surface(pat, c - vec2f(e, 0.0)).pos;
    let pv = surface(pat, c + vec2f(0.0, e)).pos - surface(pat, c - vec2f(0.0, e)).pos;
    n = cross(pu, pv);
    let l = length(n);
    n = select(vec3f(0.0, 1.0, 0.0), n / l, l > 1e-12);
  }
  vertices[vid] = Vertex(vec4f(s.pos, s.ao), vec4f(normalize(n), s.mat), s.uv);
}
`;

/**
 * Builds all variants of one kind of mesh. `surfaceWgsl` must define
 * `fn surface(pat: Patch, uv: vec2f) -> SurfacePoint` and may read `aux`.
 */
export async function buildMesh(
  device: GPUDevice,
  label: string,
  surfaceWgsl: string,
  variants: {patches: Patch[]; radius: number}[],
  seed: number,
  aux: Float32Array = new Float32Array(4),
): Promise<BuiltMesh> {
  let vertexCount = 0;
  let indexCount = 0;
  let patchCount = 0;
  for (const v of variants) {
    for (const p of v.patches) {
      vertexCount += (p.segU + 1) * (p.segV + 1);
      indexCount += p.segU * p.segV * 6;
      patchCount++;
    }
  }
  const patchData = new ArrayBuffer(patchCount * 80);
  const patchU32 = new Uint32Array(patchData);
  const patchF32 = new Float32Array(patchData);
  const vertexPatch = new Uint32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  const ranges: VariantRange[] = [];

  let vOff = 0;
  let iOff = 0;
  let pi = 0;
  variants.forEach((variant, vi) => {
    const firstIndex = iOff;
    for (const p of variant.patches) {
      const base = pi * 20;
      patchU32[base] = p.segU;
      patchU32[base + 1] = p.segV;
      patchU32[base + 2] = vOff;
      patchU32[base + 3] = vi;
      patchF32.set(p.params.slice(0, 16), base + 4);
      const cols = p.segU + 1;
      const n = cols * (p.segV + 1);
      vertexPatch.fill(pi, vOff, vOff + n);
      for (let y = 0; y < p.segV; y++) {
        for (let x = 0; x < p.segU; x++) {
          const i0 = vOff + y * cols + x;
          const i1 = i0 + 1;
          const i2 = i0 + cols;
          const i3 = i2 + 1;
          indices[iOff++] = i0;
          indices[iOff++] = i1;
          indices[iOff++] = i2;
          indices[iOff++] = i1;
          indices[iOff++] = i3;
          indices[iOff++] = i2;
        }
      }
      vOff += n;
      pi++;
    }
    ranges.push({
      firstIndex,
      indexCount: iOff - firstIndex,
      radius: variant.radius,
    });
  });

  const storage = (
    name: string,
    data: ArrayBufferView | ArrayBuffer,
    extra = 0,
  ) => {
    const bytes =
      data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
    const buf = device.createBuffer({
      label: `${label}:${name}`,
      size: Math.max(16, Math.ceil(bytes / 4) * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extra,
    });
    device.queue.writeBuffer(buf, 0, data as ArrayBuffer);
    return buf;
  };
  const patchesBuf = storage('patches', patchData);
  const vertexPatchBuf = storage('vertex-patch', vertexPatch);
  const auxBuf = storage('aux', aux.byteLength ? aux : new Float32Array(4));
  const vertexBuffer = device.createBuffer({
    label: `${label}:vertices`,
    size: vertexCount * VERTEX_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
  });
  const indexBuffer = device.createBuffer({
    label: `${label}:indices`,
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indices);
  const info = device.createBuffer({
    label: `${label}:info`,
    size: 8,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(info, 0, new Uint32Array([vertexCount, seed]));

  const module = createShader(
    device,
    `${label}:builder-shader`,
    builderShader(surfaceWgsl),
  );
  const ro = {type: 'read-only-storage'} as const;
  const bgl = device.createBindGroupLayout({
    label: `${label}:builder-bgl`,
    entries: [
      {binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: ro},
      {binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: ro},
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {type: 'storage'},
      },
      {binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: ro},
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {type: 'uniform'},
      },
    ],
  });
  const pipeline = await device.createComputePipelineAsync({
    label: `${label}:builder-pipeline`,
    layout: device.createPipelineLayout({
      label: `${label}:builder-layout`,
      bindGroupLayouts: [bgl],
    }),
    compute: {module, entryPoint: 'main'},
  });
  const bindGroup = device.createBindGroup({
    label: `${label}:builder-bind-group`,
    layout: bgl,
    entries: [
      {binding: 0, resource: {buffer: patchesBuf}},
      {binding: 1, resource: {buffer: vertexPatchBuf}},
      {binding: 2, resource: {buffer: vertexBuffer}},
      {binding: 3, resource: {buffer: auxBuf}},
      {binding: 4, resource: {buffer: info}},
    ],
  });
  const encoder = device.createCommandEncoder({
    label: `${label}:builder-encoder`,
  });
  const pass = encoder.beginComputePass({label: `${label}:builder-pass`});
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  const perRow = 8192;
  pass.dispatchWorkgroups(
    Math.ceil(Math.min(vertexCount, perRow) / 8),
    Math.ceil(Math.ceil(vertexCount / perRow) / 8),
  );
  pass.end();
  device.queue.submit([encoder.finish({label: `${label}:builder-commands`})]);
  await device.queue.onSubmittedWorkDone();
  patchesBuf.destroy();
  vertexPatchBuf.destroy();
  auxBuf.destroy();
  info.destroy();
  return {vertexBuffer, indexBuffer, variants: ranges, vertexCount};
}
