// Volumetric terrain: the seabed as a 3D density field rather than a height
// map, so it can undercut, overhang and be tunnelled through — the things a
// height map cannot express, because it has one surface height per point.
//
// The field is negative inside rock and positive in the water. Its baseline is
// the height map the rest of the world is still built from, so the shape
// matches; on top of that sit the 3D features: walls that lean out over their
// own feet, and tunnels bored through the rock.
//
// Meshing is surface nets, run on the GPU per chunk: one vertex per cell the
// surface passes through, placed at the mean of the crossings on that cell's
// edges, and a quad for every grid edge whose sign changes. No lookup tables,
// manifold output, and normals come from the field's gradient rather than from
// the triangles, so they stay smooth however coarse the grid is.
//
// Chunks overlap by one cell, so the quads along a boundary are emitted by
// exactly one of the two chunks and the surface stays closed across it.

import {createShader} from '../gpu/device.ts';
import {readBuffer} from '../gpu/util.ts';
import {noise, surfaceLib} from '../shaders/index.ts';
import {sidePlanes, sphereInside} from '../render/frustum.ts';
import {DEPTH_FORMAT} from '../render/renderer.ts';
import type {CullView} from '../render/renderer.ts';
import {terrainMaterialWgsl, type TerrainData} from './terrain.ts';

/** Cells per chunk side; one chunk spans CHUNK * cellSize metres. */
const CHUNK = 32;
/** Field samples per chunk side: the cells, plus a ring of margin. */
const N = CHUNK + 3;
/** Cells meshed per chunk side, including the one-cell overlap. */
const C = CHUNK + 2;
/** Floats per vertex: position, then normal. */
const VF = 6;
const PARAM_STRIDE = 256;

/**
 * Checks the meshed surface against the height map it was built from: with the
 * 3D terms off the two should agree to well under a cell, and anything bigger
 * is the mesher misplacing vertices.
 */
async function reportVertexError(
  device: GPUDevice,
  vertices: GPUBuffer,
  totals: Uint32Array,
  chunks: number,
  cpu: TerrainData,
  s: VoxelSettings,
) {
  const count = Math.min(chunks ? totals[(chunks - 1) * 2] : 0, 200000);
  if (!count) {
    return;
  }
  const staging = device.createBuffer({
    label: 'voxel:vertex-readback',
    size: count * VF * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = device.createCommandEncoder({label: 'voxel:vertex-copy'});
  enc.copyBufferToBuffer(vertices, 0, staging, 0, count * VF * 4);
  device.queue.submit([enc.finish({label: 'voxel:vertex-copy'})]);
  await staging.mapAsync(GPUMapMode.READ);
  const v = new Float32Array(staging.getMappedRange());
  let worst = 0;
  let over = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const x = v[i * VF];
    const y = v[i * VF + 1];
    const z = v[i * VF + 2];
    const e = Math.abs(y - cpu.heightAt(x, z));
    if (e > 40) {
      continue;
    }
    worst = Math.max(worst, e);
    sum += e;
    n++;
    if (e > s.cellSize) {
      over++;
    }
  }
  console.log(
    `[voxel] vertex error vs height map: mean ${(sum / Math.max(n, 1)).toFixed(2)} m, ` +
      `worst ${worst.toFixed(2)} m, ${((over / Math.max(n, 1)) * 100).toFixed(1)}% over one cell ` +
      `(cell ${s.cellSize} m, ${n} sampled)`,
  );
  // Where the bad ones sit inside their chunk, to tell a boundary bug from a
  // sampling one.
  const span = CHUNK * s.cellSize;
  let edge = 0;
  let bad = 0;
  const examples: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = v[i * VF];
    const y = v[i * VF + 1];
    const z = v[i * VF + 2];
    const e = Math.abs(y - cpu.heightAt(x, z));
    if (e <= s.cellSize || e > 40) {
      continue;
    }
    bad++;
    const local = [x, y, z].map(c => {
      const f = (((c / span) % 1) + 1) % 1;
      return Math.min(f, 1 - f) * span;
    });
    if (Math.min(...local) < s.cellSize * 1.5) {
      edge++;
    }
    if (examples.length < 5) {
      examples.push(
        `(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) off by ${e.toFixed(1)} m, ` +
          `${local.map(c => c.toFixed(1)).join('/')} from a chunk edge`,
      );
    }
  }
  console.log(
    `[voxel] of ${bad} bad vertices, ${((edge / Math.max(bad, 1)) * 100).toFixed(0)}% lie within ` +
      '1.5 cells of a chunk boundary',
  );
  examples.forEach(e => console.log(`[voxel]   ${e}`));
  staging.unmap();
  staging.destroy();
}

export interface VoxelSettings {
  worldSize: number;
  /** Metres per cell. */
  cellSize: number;
  /** Vertical extent to mesh, in metres. */
  minY: number;
  maxY: number;
  seed: number;
  /** Strength of the 3D features; 0 reproduces the height map exactly. */
  relief: number;
  /** Log how far the meshed surface sits from the height map. */
  debugStats?: boolean;
}

const fieldWgsl = /* wgsl */ `
${noise}

struct Params {
  origin: vec3f,
  cell: f32,
  worldSize: f32,
  seed: f32,
  relief: f32,
  pad: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(1) @binding(0) var tHeight: texture_2d<f32>;
@group(1) @binding(1) var sHeight: sampler;

fn heightTap(xz: vec2f) -> f32 {
  return textureSampleLevel(tHeight, sHeight, xz / P.worldSize + 0.5, 0.0).r;
}

/**
 * The height map, smoothed to the cell size.
 *
 * The map carries ripples and ledges finer than a cell, and a grid cannot hold
 * detail it cannot sample: asked to, it quilts, each cell tilting whichever way
 * its own corners fell. The geometry takes the broad shape and the material's
 * own relief puts the fine detail back, which is how it is done everywhere.
 */
fn baseHeight(xz: vec2f) -> f32 {
  let e = P.cell * 0.6;
  return heightTap(xz) * 0.36 +
    (heightTap(xz + vec2f(e, 0.0)) + heightTap(xz - vec2f(e, 0.0)) +
     heightTap(xz + vec2f(0.0, e)) + heightTap(xz - vec2f(0.0, e))) * 0.13 +
    (heightTap(xz + vec2f(e, e)) + heightTap(xz + vec2f(e, -e)) +
     heightTap(xz + vec2f(-e, e)) + heightTap(xz + vec2f(-e, -e))) * 0.03;
}

/**
 * How much steeper than flat the ground is here: sqrt(1 + |grad h|^2).
 *
 * "Height above the ground" is not a distance to it. On a wall of slope s, a
 * point one metre out from the rock is s metres above the height map, and the
 * mesher — which finds the surface by interpolating the field along cell edges
 * — puts its vertices in the wrong place by that factor. Dividing by this
 * turns the field back into a distance, and steep walls stop stair-stepping.
 */
fn slopeScale(xz: vec2f) -> f32 {
  let e = max(P.cell, 0.3);
  let gx = (baseHeight(xz + vec2f(e, 0.0)) - baseHeight(xz - vec2f(e, 0.0))) / (2.0 * e);
  let gz = (baseHeight(xz + vec2f(0.0, e)) - baseHeight(xz - vec2f(0.0, e))) / (2.0 * e);
  return sqrt(1.0 + gx * gx + gz * gz);
}

/**
 * Negative inside rock, positive in the water, roughly in metres.
 *
 * The height map sets the shape; the 3D terms are what it could not say.
 */
fn density(p: vec3f) -> f32 {
  if (P.relief < -0.5) {
    // Debug: a smooth analytic surface, to tell a broken field from a broken
    // mesher.
    // A steep ramp (slope 4, about 76 degrees) with a flat top and bottom.
    return p.y + 16.0 - clamp(p.x * 4.0, -12.0, 12.0);
  }
  if (P.relief <= 0.0) {
    return p.y - baseHeight(p.xz);
  }
  // Overhangs come from warping the *lookup*, not from adding noise to the
  // field: each height samples the terrain from a slightly shifted place, so a
  // wall leans further out the further down you go. Adding noise to the field
  // instead makes lips thinner than a cell, which surface nets cannot mesh —
  // it has one vertex per cell — and the surface tears into square holes.
  let rough = baseHeight(p.xz);
  let deep = rough - p.y;
  let band = smoothstep(0.0, 12.0, deep) * smoothstep(34.0, 16.0, deep);
  let sway = vec2f(
    fbm3(p * 0.045 + P.seed, 3),
    fbm3(p * 0.045 + P.seed + 17.0, 3),
  ) * 3.2 * P.relief * band;
  let ground = baseHeight(p.xz + sway);
  var d = p.y - ground;

  // Tunnels: the near-zero shells of two warped fields, intersected, so they
  // form connected tubes rather than blobs or a sponge. Only where a slow
  // regional mask allows, well under the surface, so most of the seabed stays
  // solid and none of them opens as a hole in the floor.
  let below = ground - p.y;
  let region = smoothstep(0.18, 0.42, fbm3(vec3f(p.x, p.y * 0.25, p.z) * 0.012 + 53.0, 2) + 0.2);
  let q = p * 0.031 + P.seed * 0.7 + 11.0;
  let tube = max(abs(fbm3(q, 3)), abs(fbm3(q * 1.27 + 5.0, 3)));
  let cover = smoothstep(4.0, 12.0, below) * smoothstep(30.0, 18.0, below) * region;
  // Carving has to fade out by *blending*, not by scaling what is being
  // maxed in. Scaled to nothing the carve is zero, and max(d, 0) then clamps
  // the field to non-negative — reading as water — through the top few metres
  // and everywhere the tunnels do not reach. That is one hole in the seabed
  // per column, which is exactly what it produced.
  let carve = (0.075 - tube) * 30.0 * P.relief;
  d = mix(d, max(d, carve), cover);
  return d;
}

@group(2) @binding(0) var<storage, read_write> field: array<f32>;

/**
 * The top of the rock in each column: march down from clear water to the first
 * solid sample, then refine.
 *
 * Everything that stands on the seabed is placed from a height, and with a
 * volumetric terrain the height map is no longer where the seabed is. A bracket
 * guessed from the height map is not safe either — the warp samples the terrain
 * from a shifted place, so the surface in a column can be metres from what the
 * height map says there. Columns where no rock is found at all are marked, and
 * the caller falls back to the height map for them.
 */
@compute @workgroup_size(8, 8)
fn top_main(@builtin(global_invocation_id) id: vec3u) {
  let n = u32(P.pad);
  if (any(id.xy >= vec2u(n))) {
    return;
  }
  let xz = ((vec2f(id.xy) + 0.5) / f32(n) - 0.5) * P.worldSize;
  let base = baseHeight(xz);
  let step = 0.5;
  let stop = base - 40.0;
  var y = base + 12.0;
  var found = 1e9;
  while (y > stop) {
    if (density(vec3f(xz.x, y, xz.y)) < 0.0) {
      found = y;
      break;
    }
    y -= step;
  }
  if (found > 1e8) {
    field[id.y * n + id.x] = 1e9;
    return;
  }
  var lo = found;
  var hi = found + step;
  for (var i = 0; i < 8; i++) {
    let mid = (lo + hi) * 0.5;
    if (density(vec3f(xz.x, mid, xz.y)) < 0.0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  field[id.y * n + id.x] = (lo + hi) * 0.5;
}

@compute @workgroup_size(4, 4, 4)
fn density_main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= vec3u(${N}u))) {
    return;
  }
  // One cell of margin on each side, so gradients at the edge are exact.
  let p = P.origin + (vec3f(id) - 1.0) * P.cell;
  field[(id.z * ${N}u + id.y) * ${N}u + id.x] = density(p);
}
`;

const meshShader = /* wgsl */ `
struct Params {
  origin: vec3f,
  cell: f32,
  worldSize: f32,
  seed: f32,
  relief: f32,
  pad: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(1) @binding(0) var<storage, read> field: array<f32>;
/** Cell -> vertex index, or NONE. */
@group(1) @binding(1) var<storage, read_write> cellVertex: array<u32>;
/** [0] vertices so far, [1] indices so far. Both run across all chunks. */
@group(1) @binding(2) var<storage, read_write> counts: array<atomic<u32>>;
@group(1) @binding(3) var<storage, read_write> verts: array<f32>;
@group(1) @binding(4) var<storage, read_write> indices: array<u32>;

const N = ${N}u;
const C = ${C}u;
const NONE = 0xffffffffu;
const VF = ${VF}u;

fn at(i: u32, j: u32, k: u32) -> f32 {
  return field[(k * N + j) * N + i];
}

/** Central-difference gradient: the surface normal, pointing into the water. */
fn grad(i: u32, j: u32, k: u32) -> vec3f {
  let a = min(vec3u(i, j, k) + 1u, vec3u(N - 1u));
  let b = max(vec3u(i, j, k), vec3u(1u)) - 1u;
  return vec3f(
    at(a.x, j, k) - at(b.x, j, k),
    at(i, a.y, k) - at(i, b.y, k),
    at(i, j, a.z) - at(i, j, b.z),
  );
}

/** One vertex per cell the surface passes through, at the mean crossing. */
@compute @workgroup_size(4, 4, 4)
fn vertices(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= vec3u(C))) {
    return;
  }
  let ci = (id.z * C + id.y) * C + id.x;
  cellVertex[ci] = NONE;
  var corner: array<f32, 8>;
  var inside = 0u;
  for (var c = 0u; c < 8u; c++) {
    let o = vec3u(c & 1u, (c >> 1u) & 1u, (c >> 2u) & 1u);
    let v = at(id.x + o.x, id.y + o.y, id.z + o.z);
    corner[c] = v;
    inside += select(0u, 1u, v < 0.0);
  }
  if (inside == 0u || inside == 8u) {
    return;
  }
  // Where to put the vertex: the point on the surface nearest the middle of
  // the cell, found with one Newton step down the field's own gradient.
  //
  // Averaging the crossings on the cell's edges — the usual surface-nets rule —
  // pulls vertices toward whichever corner the surface happens to graze, and on
  // ground that runs near the grid the pull alternates cell by cell, quilting
  // the surface at cell scale. Stepping from the centre instead has no such
  // bias, and for a smooth field lands within a few centimetres of the surface.
  let mid = (corner[0] + corner[1] + corner[2] + corner[3] +
    corner[4] + corner[5] + corner[6] + corner[7]) * 0.125;
  let g = vec3f(
    (corner[1] + corner[3] + corner[5] + corner[7]) -
      (corner[0] + corner[2] + corner[4] + corner[6]),
    (corner[2] + corner[3] + corner[6] + corner[7]) -
      (corner[0] + corner[1] + corner[4] + corner[5]),
    (corner[4] + corner[5] + corner[6] + corner[7]) -
      (corner[0] + corner[1] + corner[2] + corner[3]),
  ) * 0.25;
  let local = clamp(
    vec3f(0.5) - g * (mid / max(dot(g, g), 1e-8)),
    vec3f(0.02),
    vec3f(0.98),
  );
  let world = P.origin + (vec3f(id) - 1.0 + local) * P.cell;
  let normal = select(vec3f(0.0, 1.0, 0.0), normalize(g), length(g) > 1e-8);
  let vi = atomicAdd(&counts[0], 1u);
  let o = vi * VF;
  if (o + VF > arrayLength(&verts)) {
    return;
  }
  cellVertex[ci] = vi;
  verts[o] = world.x;
  verts[o + 1u] = world.y;
  verts[o + 2u] = world.z;
  verts[o + 3u] = normal.x;
  verts[o + 4u] = normal.y;
  verts[o + 5u] = normal.z;
}

/**
 * A quad for every grid edge whose sign changes, joining the vertices of the
 * four cells around that edge, wound so the front face points into the water.
 */
@compute @workgroup_size(4, 4, 4)
fn quads(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= vec3u(C)) || any(id < vec3u(1u))) {
    return;
  }
  let v0 = at(id.x, id.y, id.z);
  for (var axis = 0u; axis < 3u; axis++) {
    var step = vec3u(0u);
    step[axis] = 1u;
    let v1 = at(id.x + step.x, id.y + step.y, id.z + step.z);
    if ((v0 < 0.0) == (v1 < 0.0)) {
      continue;
    }
    var da = vec3u(0u);
    var db = vec3u(0u);
    da[(axis + 1u) % 3u] = 1u;
    db[(axis + 2u) % 3u] = 1u;
    let c0 = id - da - db;
    let c1 = id - db;
    let c2 = id;
    let c3 = id - da;
    let i0 = cellVertex[(c0.z * C + c0.y) * C + c0.x];
    let i1 = cellVertex[(c1.z * C + c1.y) * C + c1.x];
    let i2 = cellVertex[(c2.z * C + c2.y) * C + c2.x];
    let i3 = cellVertex[(c3.z * C + c3.y) * C + c3.x];
    if (i0 == NONE || i1 == NONE || i2 == NONE || i3 == NONE) {
      continue;
    }
    let base = atomicAdd(&counts[1], 6u);
    if (base + 6u > arrayLength(&indices)) {
      continue;
    }
    if (v0 < 0.0) {
      indices[base] = i0;
      indices[base + 1u] = i1;
      indices[base + 2u] = i2;
      indices[base + 3u] = i0;
      indices[base + 4u] = i2;
      indices[base + 5u] = i3;
    } else {
      indices[base] = i0;
      indices[base + 1u] = i2;
      indices[base + 2u] = i1;
      indices[base + 3u] = i0;
      indices[base + 4u] = i3;
      indices[base + 5u] = i2;
    }
  }
}
`;

export interface VoxelChunk {
  /** Range in the shared index buffer. */
  first: number;
  count: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface VoxelMesh {
  vertices: GPUBuffer;
  indices: GPUBuffer;
  chunks: VoxelChunk[];
  vertexCount: number;
  indexCount: number;
  /** Top of the rock per column, on a `topGrid` square over the world. */
  top: Float32Array;
  topGrid: number;
}

/** Columns per side for the ground-height grid read back to the CPU. */
const TOP_GRID = 512;

/**
 * Runs the top-surface pass and reads it back, filling in any column where no
 * rock was found from the height map, so the result is always usable.
 */
async function meshTopSurface(
  device: GPUDevice,
  module: GPUShaderModule,
  paramsLayout: GPUBindGroupLayout,
  heightLayout: GPUBindGroupLayout,
  outLayout: GPUBindGroupLayout,
  heightGroup: GPUBindGroup,
  cpu: TerrainData,
  s: VoxelSettings,
): Promise<Float32Array> {
  const buf = device.createBuffer({
    label: 'voxel:top',
    size: TOP_GRID * TOP_GRID * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const params = device.createBuffer({
    label: 'voxel:top-params',
    size: PARAM_STRIDE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // `pad` carries the grid size for this pass; the origin is unused.
  device.queue.writeBuffer(
    params,
    0,
    new Float32Array([
      0,
      0,
      0,
      s.cellSize,
      s.worldSize,
      s.seed % 1024,
      s.relief,
      TOP_GRID,
    ]),
  );
  const pipeline = await device.createComputePipelineAsync({
    label: 'voxel:top-pipeline',
    layout: device.createPipelineLayout({
      label: 'voxel:top-layout',
      bindGroupLayouts: [paramsLayout, heightLayout, outLayout],
    }),
    compute: {module, entryPoint: 'top_main'},
  });
  const enc = device.createCommandEncoder({label: 'voxel:top-encoder'});
  const pass = enc.beginComputePass({label: 'voxel:top-pass'});
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      label: 'voxel:top-params-bind-group',
      layout: paramsLayout,
      entries: [{binding: 0, resource: {buffer: params, size: 32}}],
    }),
    [0],
  );
  pass.setBindGroup(1, heightGroup);
  pass.setBindGroup(
    2,
    device.createBindGroup({
      label: 'voxel:top-out-bind-group',
      layout: outLayout,
      entries: [{binding: 0, resource: {buffer: buf}}],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(TOP_GRID / 8), Math.ceil(TOP_GRID / 8));
  pass.end();
  device.queue.submit([enc.finish({label: 'voxel:top'})]);
  const top = new Float32Array(await readBuffer(device, buf));
  buf.destroy();
  let missing = 0;
  let zero = 0;
  for (let i = 0; i < top.length; i++) {
    if (top[i] === 0) {
      zero++;
    }
    if (top[i] > 1e8) {
      missing++;
      const x = ((i % TOP_GRID) / TOP_GRID - 0.5) * s.worldSize;
      const z = (Math.floor(i / TOP_GRID) / TOP_GRID - 0.5) * s.worldSize;
      top[i] = cpu.heightAt(x, z);
    }
  }
  console.log(
    `[voxel] ground surface: ${((missing / top.length) * 100).toFixed(1)}% no rock found, ` +
      `${((zero / top.length) * 100).toFixed(1)}% never written`,
  );
  return top;
}

/** Meshes the field into one vertex and index buffer, chunk by chunk. */
export async function buildVoxelTerrain(
  device: GPUDevice,
  heightTexture: GPUTexture,
  cpu: TerrainData,
  s: VoxelSettings,
): Promise<VoxelMesh> {
  const span = CHUNK * s.cellSize;
  const half = s.worldSize / 2;
  const across = Math.ceil(s.worldSize / span);
  const up = Math.ceil((s.maxY - s.minY) / span);
  // How far the 3D terms move the surface away from the height map: tunnels
  // carve well below it, and the warp bulges a few metres above.
  const undercut = 36;
  const lift = 6;
  /** How far sideways the warp can move a height lookup. */
  const sway = 4;

  // Which chunks can hold surface, from the height map's range over each
  // column: most of the volume is solid rock or open water and can be skipped.
  const boxes: {origin: [number, number, number]}[] = [];
  for (let cz = 0; cz < across; cz++) {
    for (let cx = 0; cx < across; cx++) {
      const x0 = -half + cx * span;
      const z0 = -half + cz * span;
      // Every height-map texel in the footprint: sampling a chunk on a coarse
      // grid steps straight over a canyon, and a chunk whose range is wrong is
      // skipped, which shows up as a hole in the seabed.
      let lo = Infinity;
      let hi = -Infinity;
      // Reaching past the chunk as well: the warp samples the height map up to
      // `sway` metres away, so ground from outside this footprint can end up
      // inside the chunk.
      const reach = span + 2 * sway;
      const steps = Math.max(8, Math.ceil(reach / (s.worldSize / cpu.size)));
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
          const h = cpu.heightAt(
            x0 - sway + (reach * i) / steps,
            z0 - sway + (reach * j) / steps,
          );
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      }
      for (let cy = 0; cy < up; cy++) {
        const y0 = s.minY + cy * span;
        // The 3D warp lifts the surface above the height map as well as below
        // it, so both bounds need room.
        if (y0 > hi + lift || y0 + span < lo - undercut) {
          continue;
        }
        boxes.push({origin: [x0, y0, z0]});
      }
    }
  }

  const field = device.createBuffer({
    label: 'voxel:field',
    size: N ** 3 * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const cellVertex = device.createBuffer({
    label: 'voxel:cell-vertex',
    size: C ** 3 * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  // The surface is two-dimensional, so a chunk holds far fewer vertices than
  // it has cells; this is a generous ceiling, not an expectation.
  const vertices = device.createBuffer({
    label: 'voxel:vertices',
    size: (1 << 21) * VF * 4,
    usage:
      GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
  });
  const indices = device.createBuffer({
    label: 'voxel:indices',
    size: (1 << 23) * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX,
  });
  const counts = device.createBuffer({
    label: 'voxel:counts',
    size: 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const tally = device.createBuffer({
    label: 'voxel:tally',
    size: Math.max(8, boxes.length * 8),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });

  // One uniform slot per chunk, so every chunk can be issued in one submit.
  const params = device.createBuffer({
    label: 'voxel:params',
    size: Math.max(PARAM_STRIDE, boxes.length * PARAM_STRIDE),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const paramData = new ArrayBuffer(
    Math.max(PARAM_STRIDE, boxes.length * PARAM_STRIDE),
  );
  boxes.forEach((b, i) => {
    const f = new Float32Array(paramData, i * PARAM_STRIDE, 8);
    f.set([...b.origin, s.cellSize, s.worldSize, s.seed % 1024, s.relief, 0]);
  });
  device.queue.writeBuffer(params, 0, paramData);

  const paramsLayout = device.createBindGroupLayout({
    label: 'voxel:params-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {type: 'uniform', hasDynamicOffset: true, minBindingSize: 32},
      },
    ],
  });
  const heightLayout = device.createBindGroupLayout({
    label: 'voxel:height-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: {sampleType: 'float'},
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        sampler: {type: 'filtering'},
      },
    ],
  });
  const fieldOutLayout = device.createBindGroupLayout({
    label: 'voxel:field-out-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {type: 'storage'},
      },
    ],
  });
  const meshLayout = device.createBindGroupLayout({
    label: 'voxel:mesh-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {type: 'read-only-storage'},
      },
      ...[1, 2, 3, 4].map(binding => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {type: 'storage' as const},
      })),
    ],
  });

  const densityModule = createShader(device, 'voxel:density-shader', fieldWgsl);
  const meshModule = createShader(device, 'voxel:mesh-shader', meshShader);
  const [densityPipeline, vertexPipeline, quadPipeline] = await Promise.all([
    device.createComputePipelineAsync({
      label: 'voxel:density-pipeline',
      layout: device.createPipelineLayout({
        label: 'voxel:density-layout',
        bindGroupLayouts: [paramsLayout, heightLayout, fieldOutLayout],
      }),
      compute: {module: densityModule, entryPoint: 'density_main'},
    }),
    device.createComputePipelineAsync({
      label: 'voxel:vertex-pipeline',
      layout: device.createPipelineLayout({
        label: 'voxel:vertex-layout',
        bindGroupLayouts: [paramsLayout, meshLayout],
      }),
      compute: {module: meshModule, entryPoint: 'vertices'},
    }),
    device.createComputePipelineAsync({
      label: 'voxel:quad-pipeline',
      layout: device.createPipelineLayout({
        label: 'voxel:quad-layout',
        bindGroupLayouts: [paramsLayout, meshLayout],
      }),
      compute: {module: meshModule, entryPoint: 'quads'},
    }),
  ]);

  const paramsGroup = device.createBindGroup({
    label: 'voxel:params-bind-group',
    layout: paramsLayout,
    entries: [{binding: 0, resource: {buffer: params, size: 32}}],
  });
  const heightGroup = device.createBindGroup({
    label: 'voxel:height-bind-group',
    layout: heightLayout,
    entries: [
      {
        binding: 0,
        resource: heightTexture.createView({label: 'voxel:height-view'}),
      },
      {
        binding: 1,
        resource: device.createSampler({
          label: 'voxel:height-sampler',
          magFilter: 'linear',
          minFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        }),
      },
    ],
  });
  const fieldOutGroup = device.createBindGroup({
    label: 'voxel:field-out-bind-group',
    layout: fieldOutLayout,
    entries: [{binding: 0, resource: {buffer: field}}],
  });
  const meshGroup = device.createBindGroup({
    label: 'voxel:mesh-bind-group',
    layout: meshLayout,
    entries: [
      {binding: 0, resource: {buffer: field}},
      {binding: 1, resource: {buffer: cellVertex}},
      {binding: 2, resource: {buffer: counts}},
      {binding: 3, resource: {buffer: vertices}},
      {binding: 4, resource: {buffer: indices}},
    ],
  });

  const fieldGroups = Math.ceil(N / 4);
  const cellGroups = Math.ceil(C / 4);
  const encoder = device.createCommandEncoder({label: 'voxel:build-encoder'});
  boxes.forEach((_, i) => {
    const offset = [i * PARAM_STRIDE];
    const pass = encoder.beginComputePass({label: `voxel:chunk-${i}`});
    pass.setPipeline(densityPipeline);
    pass.setBindGroup(0, paramsGroup, offset);
    pass.setBindGroup(1, heightGroup);
    pass.setBindGroup(2, fieldOutGroup);
    pass.dispatchWorkgroups(fieldGroups, fieldGroups, fieldGroups);
    pass.end();
    const verts = encoder.beginComputePass({label: `voxel:verts-${i}`});
    verts.setPipeline(vertexPipeline);
    verts.setBindGroup(0, paramsGroup, offset);
    verts.setBindGroup(1, meshGroup);
    verts.dispatchWorkgroups(cellGroups, cellGroups, cellGroups);
    verts.end();
    const quads = encoder.beginComputePass({label: `voxel:quads-${i}`});
    quads.setPipeline(quadPipeline);
    quads.setBindGroup(0, paramsGroup, offset);
    quads.setBindGroup(1, meshGroup);
    quads.dispatchWorkgroups(cellGroups, cellGroups, cellGroups);
    quads.end();
    // Running totals after this chunk: its index range ends here.
    encoder.copyBufferToBuffer(counts, 0, tally, i * 8, 8);
  });
  device.queue.submit([encoder.finish({label: 'voxel:build'})]);

  const top = await meshTopSurface(
    device,
    densityModule,
    paramsLayout,
    heightLayout,
    fieldOutLayout,
    heightGroup,
    cpu,
    s,
  );

  const totals = new Uint32Array(await readBuffer(device, tally));
  const chunks: VoxelChunk[] = boxes.map((b, i) => {
    const endIndices = totals[i * 2 + 1];
    const startIndices = i === 0 ? 0 : totals[(i - 1) * 2 + 1];
    return {
      first: startIndices,
      count: endIndices - startIndices,
      min: [b.origin[0], b.origin[1], b.origin[2]],
      max: [b.origin[0] + span, b.origin[1] + span, b.origin[2] + span],
    };
  });
  field.destroy();
  cellVertex.destroy();
  tally.destroy();
  if (s.debugStats) {
    await reportVertexError(device, vertices, totals, boxes.length, cpu, s);
  }
  return {
    vertices,
    indices,
    chunks,
    vertexCount: boxes.length ? totals[(boxes.length - 1) * 2] : 0,
    indexCount: boxes.length ? totals[(boxes.length - 1) * 2 + 1] : 0,
    top,
    topGrid: TOP_GRID,
  };
}

// ---------------------------------------------------------------------------
// Rendering

const renderShader = /* wgsl */ `
${surfaceLib}
${terrainMaterialWgsl}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) prevClip: vec4f,
  @location(3) curClip: vec4f,
};

@vertex
fn vs(@location(0) inPos: vec3f, @location(1) inNormal: vec3f) -> VOut {
  var o: VOut;
  o.pos = frame.viewProj * vec4f(inPos, 1.0);
  o.world = inPos;
  o.normal = inNormal;
  o.curClip = frame.viewProjNoJitter * vec4f(inPos, 1.0);
  o.prevClip = frame.prevViewProjNoJitter * vec4f(inPos, 1.0);
  return o;
}

@fragment
fn fs(i: VOut) -> FOut {
  let uv = i.world.xz / frame.terrain.x + 0.5;
  let m = textureSample(tTerrainMask, sLinearClamp, uv);
  let t = textureSample(tTerrain, sLinearClamp, uv);
  let p = i.world;
  let n = normalize(i.normal);
  // Ceilings and undercuts have no sky above them, and no baked height-map
  // occlusion to read: shade them by how far they face down instead.
  let ao = mix(t.a, 0.35, smoothstep(0.0, -0.5, n.y));
  let s = terrainSurface(p, n, m, ao);
  let lit = shadeSurface(s, p, -1.0);
  var o: FOut;
  o.color = vec4f(applyWater(lit, p), 1.0);
  o.velocity = screenVelocity(i.curClip, i.prevClip);
  return o;
}

/**
 * Debug view: solid colour, one directional light, no water and no shadows, so
 * the silhouette and any hole in the surface are obvious. Back faces are drawn
 * red, so seeing red means looking through the surface at its inside.
 */
@fragment
fn fsFlat(i: VOut, @builtin(front_facing) front: bool) -> FOut {
  // Geometric normal from the triangle itself, not the field gradient: if the
  // blocky look survives this, it is in the geometry.
  let n = normalize(cross(dpdxFine(i.world), dpdyFine(i.world))) * -1.0;
  let key = clamp(dot(n, normalize(vec3f(0.4, 0.85, 0.3))), 0.0, 1.0);
  let col = vec3f(0.55, 0.6, 0.62) * (0.25 + 0.75 * key);
  var o: FOut;
  o.color = vec4f(select(vec3f(1.2, 0.0, 0.0), col, front), 1.0);
  o.velocity = screenVelocity(i.curClip, i.prevClip);
  return o;
}

@vertex
fn vsShadow(@location(0) inPos: vec3f, @location(1) inNormal: vec3f) -> @builtin(position) vec4f {
  // Pushed a shadow texel into the rock, so a surface never shadows itself.
  // (The mesh is closed, and only its far side is drawn into the map, so this
  // cannot pull a shadow away from the foot of anything standing on it.)
  let p = inPos - normalize(inNormal) * frame.shadow.x * 1.5;
  return frame.shadowViewProj * vec4f(p, 1.0);
}
`;

export interface VoxelRenderer {
  update(view: CullView): void;
  draw(pass: GPURenderPassEncoder): void;
  drawShadow(pass: GPURenderPassEncoder): void;
  readonly stats: {chunks: number; triangles: number};
}

/** Draws the meshed field, one run of chunks per visible stretch. */
export async function createVoxelRenderer(
  device: GPUDevice,
  globalsLayout: GPUBindGroupLayout,
  targets: {
    color: GPUTextureFormat;
    velocity: GPUTextureFormat;
    depth: GPUTextureFormat;
  },
  mesh: VoxelMesh,
  debug = false,
): Promise<VoxelRenderer> {
  const module = createShader(device, 'voxel:render-shader', renderShader);
  const layout = device.createPipelineLayout({
    label: 'voxel:render-layout',
    bindGroupLayouts: [globalsLayout],
  });
  const buffers: GPUVertexBufferLayout[] = [
    {
      arrayStride: VF * 4,
      attributes: [
        {shaderLocation: 0, offset: 0, format: 'float32x3'},
        {shaderLocation: 1, offset: 12, format: 'float32x3'},
      ],
    },
  ];
  const [pipeline, shadowPipeline] = await Promise.all([
    device.createRenderPipelineAsync({
      label: 'voxel:pipeline',
      layout,
      vertex: {module, entryPoint: 'vs', buffers},
      fragment: {
        module,
        entryPoint: debug ? 'fsFlat' : 'fs',
        targets: [{format: targets.color}, {format: targets.velocity}],
      },
      primitive: {topology: 'triangle-list', cullMode: debug ? 'none' : 'back'},
      depthStencil: {
        format: targets.depth,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    }),
    device.createRenderPipelineAsync({
      label: 'voxel:shadow-pipeline',
      layout,
      vertex: {module, entryPoint: 'vsShadow', buffers},
      // Only the faces turned away from the light write depth: the classic
      // cure for a closed mesh shadowing itself.
      primitive: {topology: 'triangle-list', cullMode: 'front'},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    }),
  ]);

  const planes = new Float32Array(16);
  const shadowPlanes = new Float32Array(16);
  const runs: {first: number; count: number}[] = [];
  const shadowRuns: {first: number; count: number}[] = [];
  const stats = {chunks: 0, triangles: 0};

  const gather = (
    out: {first: number; count: number}[],
    keep: (c: VoxelChunk) => boolean,
  ) => {
    out.length = 0;
    for (const c of mesh.chunks) {
      if (!c.count || !keep(c)) {
        continue;
      }
      const last = out[out.length - 1];
      if (last && last.first + last.count === c.first) {
        last.count += c.count;
      } else {
        out.push({first: c.first, count: c.count});
      }
    }
  };
  const visible = (p: Float32Array) => (c: VoxelChunk) => {
    const cx = (c.min[0] + c.max[0]) / 2;
    const cy = (c.min[1] + c.max[1]) / 2;
    const cz = (c.min[2] + c.max[2]) / 2;
    const r = Math.hypot(c.max[0] - cx, c.max[1] - cy, c.max[2] - cz);
    return sphereInside(p, cx, cy, cz, r);
  };

  return {
    stats,
    update(view: CullView) {
      sidePlanes(view.viewProj, planes);
      sidePlanes(view.shadowViewProj, shadowPlanes);
      const cam = view.camPos;
      const maxD = view.maxDistance;
      gather(runs, c => {
        const dx = Math.max(c.min[0] - cam[0], 0, cam[0] - c.max[0]);
        const dy = Math.max(c.min[1] - cam[1], 0, cam[1] - c.max[1]);
        const dz = Math.max(c.min[2] - cam[2], 0, cam[2] - c.max[2]);
        return Math.hypot(dx, dy, dz) < maxD && visible(planes)(c);
      });
      gather(shadowRuns, visible(shadowPlanes));
      stats.chunks = runs.length;
      stats.triangles = runs.reduce((n, r) => n + r.count / 3, 0);
    },
    draw(pass: GPURenderPassEncoder) {
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, mesh.vertices);
      pass.setIndexBuffer(mesh.indices, 'uint32');
      for (const r of runs) {
        pass.drawIndexed(r.count, 1, r.first, 0, 0);
      }
    },
    drawShadow(pass: GPURenderPassEncoder) {
      pass.setPipeline(shadowPipeline);
      pass.setVertexBuffer(0, mesh.vertices);
      pass.setIndexBuffer(mesh.indices, 'uint32');
      for (const r of shadowRuns) {
        pass.drawIndexed(r.count, 1, r.first, 0, 0);
      }
    },
  };
}
