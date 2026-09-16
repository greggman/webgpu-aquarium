// Seafloor generation (GPU compute) and rendering.
//
// The world is a basin: a sandy floor with rock outcrops, ringed by cliffs that
// rise toward the surface, with one gap that drops away into deep water. The
// camera is kept inside the basin so the edges of the generated world are
// never visible.

import {createShader} from '../gpu/device.ts';
import {boxOutside, sidePlanes} from '../render/frustum.ts';
import type {CullView} from '../render/renderer.ts';
import {defineStruct, StructBuffer} from '../gpu/structs.ts';
import {dispatch2D, readBuffer} from '../gpu/util.ts';
import {noise, surfaceLib} from '../shaders/index.ts';
import type {Rng} from '../core/rng.ts';
import propsWgsl from '../shaders/props.wgsl';

export const TerrainParams = defineStruct('TerrainParams', {
  seed: 'u32',
  size: 'u32',
  worldSize: 'f32',
  floorDepth: 'f32',
  center: 'vec2f',
  basinRadius: 'f32',
  rimHeight: 'f32',
  gapAngle: 'f32',
  gapWidth: 'f32',
  duneAmp: 'f32',
  rockiness: 'f32',
  warp: 'f32',
  surfaceY: 'f32',
  outcropScale: 'f32',
  spurHeight: 'f32',
  canyonDepth: 'f32',
  canyonWidth: 'f32',
  canyonScale: 'f32',
});

export interface TerrainSettings {
  seed: number;
  size: number;
  worldSize: number;
  floorDepth: number;
  center: [number, number];
  basinRadius: number;
  rimHeight: number;
  gapAngle: number;
  gapWidth: number;
  duneAmp: number;
  rockiness: number;
  warp: number;
  surfaceY: number;
  outcropScale: number;
  /** Height of the spur-and-groove reef ridges leading to the drop-off. */
  spurHeight: number;
  /** Depth of the main canyon floors below the surrounding seabed. */
  canyonDepth: number;
  /** Half-width of a main canyon at the rim, in metres. */
  canyonWidth: number;
  /** Size of the channel network: smaller means longer, straighter canyons. */
  canyonScale: number;
}

export function randomTerrainSettings(
  rng: Rng,
  surfaceY: number,
): TerrainSettings {
  return {
    seed: rng.nextU32(),
    size: 512,
    worldSize: 320,
    floorDepth: rng.range(-19, -14),
    center: [0, 0],
    basinRadius: rng.range(52, 64),
    rimHeight: rng.range(7, 10),
    gapAngle: rng.range(0, Math.PI * 2),
    gapWidth: rng.range(0.45, 0.8),
    duneAmp: rng.range(0.8, 2.0),
    rockiness: rng.range(0.6, 1.3),
    warp: rng.range(0.6, 1.2),
    surfaceY,
    outcropScale: rng.range(0.8, 1.25),
    spurHeight: rng.range(2.5, 4.5),
    canyonDepth: rng.range(9, 14),
    canyonWidth: rng.range(4.5, 6.5),
    canyonScale: rng.range(0.8, 1.2),
  };
}

const genShader = /* wgsl */ `
${noise}
${TerrainParams.wgsl}
@group(0) @binding(0) var<uniform> P: TerrainParams;
@group(0) @binding(1) var<storage, read_write> heights: array<f32>;


/**
 * Spur-and-groove reef: parallel coral ridges running toward the gap in the
 * rim, separated by sand channels, ending at the drop-off. Returns the ridge
 * height factor (0 in channels and outside the zone, 1 on ridge crests).
 */
fn spurMask(p: vec2f) -> f32 {
  let gapDir = vec2f(cos(P.gapAngle), sin(P.gapAngle));
  let side = vec2f(-gapDir.y, gapDir.x);
  let d = p - P.center;
  let along = dot(d, gapDir);
  let across = dot(d, side);
  let R = P.basinRadius;
  let zone = smoothstep(-R * 0.25, R * 0.25, along) *
    smoothstep(R * 1.0, R * 0.75, along) *
    smoothstep(R * 0.85, R * 0.35, abs(across));
  // Grooves wander a little and are spaced ~10 m apart.
  let groove = across * 0.62 + fbm2(p * 0.04 + 5.0, 3) * 2.6;
  // Rounded, knobbly crests: the ridge breaks into coalescing coral heads
  // along its length rather than running as a clean wedge.
  let wave = 0.5 + 0.5 * sin(groove);
  let rounded = smoothstep(0.15, 0.95, wave);
  let knobs = 0.65 + 0.35 * smoothstep(-0.35, 0.35, fbm2(vec2f(along * 0.16, across * 0.05) + 13.0, 3));
  let lumps = 1.0 + fbm2(p * 0.32 + 21.0, 2) * 0.35;
  return zone * rounded * knobs * lumps;
}

/**
 * A dissected seabed: a branching network of canyons and gullies, cut into
 * whatever the rest of the terrain built.
 *
 * Channel centrelines are the zero crossings of a warped fbm, so they wander
 * and branch like drainage rather than like noise. Three scales are cut: main
 * canyons, gullies feeding them, and fine rills on the walls. The domain is
 * stretched along the drainage direction, so the system runs one way — toward
 * the gap in the rim, where the floor falls away into the deep.
 *
 * Returns metres to cut (positive).
 */
fn canyonCut(p: vec2f) -> f32 {
  let flow = vec2f(cos(P.gapAngle), sin(P.gapAngle));
  let across = vec2f(-flow.y, flow.x);
  // Stretched along the flow: channels run down it instead of meandering.
  // Stretched along the flow, but by a varying amount, so the system is not a
  // set of parallel furrows.
  let bend = fbm2(p * 0.004 + 61.0, 2) * 0.5;
  let g = vec2f(dot(p, flow) * (0.3 + bend * 0.5), dot(p, across)) * 0.0085 * P.canyonScale;
  let warpV = vec2f(fbm2(g * 1.7 + 5.0, 4), fbm2(g * 1.7 + 19.0, 4));
  let q = g + warpV * 0.7;

  // Not everywhere: broad stretches of the basin stay open sand, and the
  // dissected ground reads against them.
  let region = smoothstep(0.1, 0.55, fbm2(p * 0.0075 + 47.0, 3) + 0.28);
  if (region <= 0.001) {
    return 0.0;
  }

  // Profile: flat floor across most of the width, then the walls rise in the
  // outer fifth of it. A smooth falloff over the whole width is what makes a
  // valley; a canyon is a floor between walls.
  // The rim wanders, so the walls are not smooth arcs.
  let rimNoise = 1.0 + fbm2(q * 9.0 + 27.0, 3) * 0.35;

  // Main canyons: near the zero crossing of a low-frequency field.
  let trunk = abs(fbm2(q, 4));
  let trunkW = P.canyonWidth * 0.019 * P.canyonScale * rimNoise;
  var cut = (1.0 - smoothstep(trunkW * 0.78, trunkW, trunk)) * P.canyonDepth;

  // Gullies: shallower, feeding the trunks.
  let branch = abs(fbm2(q * 2.2 + 3.3, 4));
  let branchW = trunkW * 0.5;
  cut += (1.0 - smoothstep(branchW * 0.7, branchW, branch)) * P.canyonDepth * 0.45;

  // Rills: a little fine dissection of the ground between them.
  let rill = abs(fbm2(q * 6.0 + 11.0, 3));
  let rillW = trunkW * 0.26;
  cut += (1.0 - smoothstep(rillW * 0.55, rillW, rill)) * P.canyonDepth * 0.14;
  // The three scales can otherwise stack into a trench half the depth of the
  // basin; a canyon is deep, not bottomless.
  cut = min(cut, P.canyonDepth * 1.1) * region;

  // Deeper downstream, fading out before the rim so the basin stays enclosed.
  let along = dot(p - P.center, flow) / max(P.basinRadius, 1.0);
  cut *= 0.65 + 0.5 * smoothstep(-1.0, 1.0, along);
  let r = length(p - P.center);
  cut *= smoothstep(P.basinRadius + 6.0, P.basinRadius - 16.0, r);
  return cut;
}

/** Ledges: flattens bands out of a slope so walls read as cut rock. */
fn terrace(h: f32, step: f32, strength: f32) -> f32 {
  let t = h / step;
  let f = fract(t);
  let shaped = floor(t) + smoothstep(0.25, 0.75, f);
  return mix(h, shaped * step, strength);
}

fn basinHeight(p: vec2f) -> f32 {
  let warpV = vec2f(fbm2(p * 0.008, 3), fbm2(p * 0.008 + vec2f(41.0, 17.0), 3));
  let q = p + warpV * 30.0 * P.warp;
  let d = q - P.center;
  let r = length(d);

  // Sandy floor with long dunes and gentle undulation.
  var h = P.floorDepth;
  h += fbm2(p * 0.018, 4) * 2.2;
  let duneDir = normalize(vec2f(0.8, 0.6));
  let dunePhase = dot(q, duneDir) * 0.11 + fbm2(p * 0.03, 2) * 1.5;
  h += (abs(sin(dunePhase)) - 0.6) * P.duneAmp * (0.5 + 0.5 * fbm2(p * 0.02 + 7.0, 2));

  // Low, rounded rocky mounds inside the basin. Tall vertical features come
  // from rock meshes instead: a heightfield can't make a clean pinnacle.
  let rid = ridged2(q * 0.035 * P.outcropScale, 4);
  let outcropMask = smoothstep(0.5, 0.9, rid) * smoothstep(0.1, 0.35, fbm2(q * 0.015 + 3.0, 3) + 0.25);
  let mound = outcropMask * outcropMask * (3.0 - 2.0 * outcropMask);
  h += mound * 3.2 * P.rockiness * (0.7 + 0.5 * fbm2(q * 0.06, 2));

  // Spur-and-groove ridges toward the drop-off.
  h += spurMask(p) * P.spurHeight * (0.75 + 0.35 * fbm2(p * 0.07 + 9.0, 3));

  // Canyons and gullies cut down through everything above: the floor is
  // dissected, not merely bumpy. Walls get ledges so they read as cut rock.
  let cut = canyonCut(p);
  if (cut > 0.05) {
    let floorNoise = fbm2(p * 0.09 + 31.0, 3) * 0.8;
    // Benches cut into the walls, so they break rather than run smoothly.
    h = terrace(h - cut + floorNoise * smoothstep(1.0, 6.0, cut), 2.2, 0.5 * smoothstep(1.0, 5.0, cut));
  }

  // Ring of cliffs.
  let angle = atan2(d.y, d.x);
  var ad = abs(angle - P.gapAngle);
  ad = min(ad, 6.2831853 - ad);
  let gap = smoothstep(P.gapWidth, P.gapWidth * 0.35, ad);
  let rimT = smoothstep(P.basinRadius - 4.0, P.basinRadius + 34.0, r);
  let cliffNoise = ridged2(q * 0.028, 6);
  var rim = rimT * (P.rimHeight + cliffNoise * 9.0);
  // Strata ledges on the cliff faces.
  rim += rimT * (fract(rim * 0.33) - 0.5) * 0.9;
  h += rim * (1.0 - gap);
  // Through the gap, the floor slopes off into the deep.
  let drop = smoothstep(P.basinRadius - 8.0, P.basinRadius + 70.0, r);
  h -= gap * drop * 45.0;

  // Never break the surface.
  // Never break the surface, but approach the cap smoothly (a hard min() would
  // leave flat, straight-edged slabs just under the water).
  let cap = P.surfaceY - 4.0 - fbm2(p * 0.05, 2) * 2.0;
  let k = 4.0;
  let hh = clamp(0.5 + 0.5 * (cap - h) / k, 0.0, 1.0);
  h = mix(cap, h, hh) - k * hh * (1.0 - hh);
  return h;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(P.size))) {
    return;
  }
  noiseSeed = P.seed;
  let uv = (vec2f(id.xy) + 0.5) / f32(P.size);
  let p = (uv - 0.5) * P.worldSize;
  heights[id.y * P.size + id.x] = basinHeight(p);
}
`;

const deriveShader = /* wgsl */ `
${noise}
${TerrainParams.wgsl}
@group(0) @binding(0) var<uniform> P: TerrainParams;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var<storage, read_write> data: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> masks: array<vec4f>;
@group(0) @binding(4) var dataTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var maskTex: texture_storage_2d<rgba8unorm, write>;


/**
 * Spur-and-groove reef: parallel coral ridges running toward the gap in the
 * rim, separated by sand channels, ending at the drop-off. Returns the ridge
 * height factor (0 in channels and outside the zone, 1 on ridge crests).
 */
fn spurMask(p: vec2f) -> f32 {
  let gapDir = vec2f(cos(P.gapAngle), sin(P.gapAngle));
  let side = vec2f(-gapDir.y, gapDir.x);
  let d = p - P.center;
  let along = dot(d, gapDir);
  let across = dot(d, side);
  let R = P.basinRadius;
  let zone = smoothstep(-R * 0.25, R * 0.25, along) *
    smoothstep(R * 1.0, R * 0.75, along) *
    smoothstep(R * 0.85, R * 0.35, abs(across));
  // Grooves wander a little and are spaced ~10 m apart.
  let groove = across * 0.62 + fbm2(p * 0.04 + 5.0, 3) * 2.6;
  // Rounded, knobbly crests: the ridge breaks into coalescing coral heads
  // along its length rather than running as a clean wedge.
  let wave = 0.5 + 0.5 * sin(groove);
  let rounded = smoothstep(0.15, 0.95, wave);
  let knobs = 0.65 + 0.35 * smoothstep(-0.35, 0.35, fbm2(vec2f(along * 0.16, across * 0.05) + 13.0, 3));
  let lumps = 1.0 + fbm2(p * 0.32 + 21.0, 2) * 0.35;
  return zone * rounded * knobs * lumps;
}

fn H(x: i32, y: i32) -> f32 {
  let s = i32(P.size);
  let cx = clamp(x, 0, s - 1);
  let cy = clamp(y, 0, s - 1);
  return heights[u32(cy * s + cx)];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(P.size))) {
    return;
  }
  noiseSeed = P.seed ^ 0x5bd1e995u;
  let x = i32(id.x);
  let y = i32(id.y);
  let texel = P.worldSize / f32(P.size);
  let h = H(x, y);
  let dx = (H(x + 1, y) - H(x - 1, y)) / (2.0 * texel);
  let dz = (H(x, y + 1) - H(x, y - 1)) / (2.0 * texel);
  let n = normalize(vec3f(-dx, 1.0, -dz));

  // Horizon-based ambient occlusion over 8 directions.
  var occl = 0.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.785398;
    let dir = vec2f(cos(a), sin(a));
    var maxSlope = -1.0;
    var dist = 1.0;
    for (var s = 0; s < 7; s++) {
      let o = vec2i(round(dir * dist));
      let dh = H(x + o.x, y + o.y) - h;
      maxSlope = max(maxSlope, dh / (dist * texel));
      dist *= 1.8;
    }
    occl += clamp(atan(maxSlope) / 1.5708, 0.0, 1.0);
  }
  let ao = clamp(1.0 - occl / 8.0 * 1.25, 0.0, 1.0);

  let uv = (vec2f(id.xy) + 0.5) / f32(P.size);
  let p = (uv - 0.5) * P.worldSize;
  // Curvature: convex ridges get rock, concave hollows collect sand.
  let lap = (H(x + 2, y) + H(x - 2, y) + H(x, y + 2) + H(x, y - 2) - 4.0 * h) / (4.0 * texel * texel);
  let slope = 1.0 - n.y;
  var rock = smoothstep(0.12, 0.35, slope) + smoothstep(0.0, -0.25, lap) * 0.6;
  rock = clamp(rock + (fbm2(p * 0.07, 3)) * 0.3, 0.0, 1.0);
  // Reef zones: mid-depth patches near rocks.
  var reef = clamp(smoothstep(-0.1, 0.35, fbm2(p * 0.025 + 19.0, 4)) * (1.0 - smoothstep(0.55, 0.9, slope)), 0.0, 1.0);
  // Ridge crests and flanks of the spur-and-groove zone are prime reef.
  let spur = spurMask(p);
  reef = max(reef, smoothstep(0.25, 0.7, spur));
  // Spurs are reef framework (rock and encrusting life), not rippled sand.
  rock = max(rock, smoothstep(0.2, 0.6, spur) * 0.95);
  // Kelp/seagrass zones: sandy, flatter, different patches.
  let kelp = clamp(smoothstep(0.0, 0.3, fbm2(p * 0.02 + 71.0, 3)) * (1.0 - rock), 0.0, 1.0);
  let moss = clamp(rock * smoothstep(0.55, 0.95, n.y) + fbm2(p * 0.2, 2) * 0.2, 0.0, 1.0);

  let i = id.y * P.size + id.x;
  data[i] = vec4f(h, n.x, n.z, ao);
  masks[i] = vec4f(rock, reef, kelp, moss);
  textureStore(dataTex, id.xy, vec4f(h, n.x, n.z, ao));
  textureStore(maskTex, id.xy, vec4f(rock, reef, kelp, moss));
}
`;

export class TerrainData {
  readonly size: number;
  readonly worldSize: number;
  readonly data: Float32Array;
  readonly masks: Float32Array;
  constructor(
    size: number,
    worldSize: number,
    data: Float32Array,
    masks: Float32Array,
  ) {
    this.size = size;
    this.worldSize = worldSize;
    this.data = data;
    this.masks = masks;
  }

  private sample(
    arr: Float32Array,
    channel: number,
    x: number,
    z: number,
  ): number {
    const s = this.size;
    const fx = Math.min(
      Math.max((x / this.worldSize + 0.5) * s - 0.5, 0),
      s - 1.001,
    );
    const fz = Math.min(
      Math.max((z / this.worldSize + 0.5) * s - 0.5, 0),
      s - 1.001,
    );
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const at = (xx: number, zz: number) => arr[(zz * s + xx) * 4 + channel];
    const a = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * tx;
    const b = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * tx;
    return a + (b - a) * tz;
  }

  heightAt(x: number, z: number) {
    return this.sample(this.data, 0, x, z);
  }
  normalAt(x: number, z: number): [number, number, number] {
    const nx = this.sample(this.data, 1, x, z);
    const nz = this.sample(this.data, 2, x, z);
    return [nx, Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)), nz];
  }
  aoAt(x: number, z: number) {
    return this.sample(this.data, 3, x, z);
  }
  /** 0 rock, 1 reef, 2 kelp, 3 moss */
  maskAt(channel: number, x: number, z: number) {
    return this.sample(this.masks, channel, x, z);
  }
}

export interface TerrainGpu {
  texture: GPUTexture;
  maskTexture: GPUTexture;
  cpu: TerrainData;
}

export async function generateTerrain(
  device: GPUDevice,
  s: TerrainSettings,
): Promise<TerrainGpu> {
  const N = s.size;
  const params = new StructBuffer(TerrainParams);
  for (const [k, v] of Object.entries(s)) {
    params.set(k as keyof typeof TerrainParams.fields, v as number | number[]);
  }
  const paramBuf = device.createBuffer({
    label: 'terrain:params',
    size: TerrainParams.size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramBuf, 0, params.data);

  const heights = device.createBuffer({
    label: 'terrain:heights',
    size: N * N * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const dataBuf = device.createBuffer({
    label: 'terrain:data',
    size: N * N * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const maskBuf = device.createBuffer({
    label: 'terrain:masks',
    size: N * N * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const texture = device.createTexture({
    label: 'terrain:texture',
    size: [N, N],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
  const maskTexture = device.createTexture({
    label: 'terrain:mask-texture',
    size: [N, N],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });

  const genModule = createShader(device, 'terrain:gen-shader', genShader);
  const genPipeline = await device.createComputePipelineAsync({
    label: 'terrain:gen-pipeline',
    layout: 'auto',
    compute: {module: genModule, entryPoint: 'main'},
  });
  const deriveModule = createShader(
    device,
    'terrain:derive-shader',
    deriveShader,
  );
  const derivePipeline = await device.createComputePipelineAsync({
    label: 'terrain:derive-pipeline',
    layout: 'auto',
    compute: {module: deriveModule, entryPoint: 'main'},
  });

  dispatch2D(
    device,
    'terrain:gen',
    genPipeline,
    [
      device.createBindGroup({
        label: 'terrain:gen-bind-group',
        layout: genPipeline.getBindGroupLayout(0),
        entries: [
          {binding: 0, resource: {buffer: paramBuf}},
          {binding: 1, resource: {buffer: heights}},
        ],
      }),
    ],
    N,
    N,
  );
  dispatch2D(
    device,
    'terrain:derive',
    derivePipeline,
    [
      device.createBindGroup({
        label: 'terrain:derive-bind-group',
        layout: derivePipeline.getBindGroupLayout(0),
        entries: [
          {binding: 0, resource: {buffer: paramBuf}},
          {binding: 1, resource: {buffer: heights}},
          {binding: 2, resource: {buffer: dataBuf}},
          {binding: 3, resource: {buffer: maskBuf}},
          {
            binding: 4,
            resource: texture.createView({label: 'terrain:data-storage-view'}),
          },
          {
            binding: 5,
            resource: maskTexture.createView({
              label: 'terrain:mask-storage-view',
            }),
          },
        ],
      }),
    ],
    N,
    N,
  );

  const [data, masks] = await Promise.all([
    readBuffer(device, dataBuf),
    readBuffer(device, maskBuf),
  ]);
  heights.destroy();
  dataBuf.destroy();
  maskBuf.destroy();
  return {
    texture,
    maskTexture,
    cpu: new TerrainData(
      N,
      s.worldSize,
      new Float32Array(data),
      new Float32Array(masks),
    ),
  };
}

// ---------------------------------------------------------------------------
// Rendering

export const terrainMaterialWgsl = /* wgsl */ `
fn triplanar(p: vec3f, n: vec3f, scale: f32) -> vec4f {
  var w = pow(abs(n), vec3f(4.0));
  w /= (w.x + w.y + w.z);
  let x = textureSample(tDetail, sLinearRepeat, p.zy * scale);
  let y = textureSample(tDetail, sLinearRepeat, p.xz * scale);
  let z = textureSample(tDetail, sLinearRepeat, p.xy * scale);
  return x * w.x + y * w.y + z * w.z;
}

/**
 * Triplanar lookup at an explicit, isotropic mip level for relief taps.
 * Hardware anisotropic filtering smears each tap along the view direction, and
 * differencing those taps turns the smear into streaks.
 */
fn triplanarLod(p: vec3f, n: vec3f, scale: f32, footprint: f32) -> vec4f {
  var w = pow(abs(n), vec3f(8.0));
  w /= (w.x + w.y + w.z);
  // One mip coarser than the tap spacing: texel-scale noise in the relief
  // only turns into sparkle and streaks once it drives the normal.
  let lod = log2(max(footprint * scale * 512.0, 1.0)) + 1.0;
  let x = textureSampleLevel(tDetail, sLinearRepeat, p.zy * scale, lod);
  let y = textureSampleLevel(tDetail, sLinearRepeat, p.xz * scale, lod);
  let z = textureSampleLevel(tDetail, sLinearRepeat, p.xy * scale, lod);
  return x * w.x + y * w.y + z * w.z;
}

/** Rock (and reef rubble) relief height, in detail-texture units. */
fn rockRelief(q: vec3f, n: vec3f, reef: f32, e: f32) -> f32 {
  return triplanarLod(q, n, 0.13, e).r * 1.2 + triplanarLod(q, n, 0.5, e).r * 0.3 +
    triplanarLod(q, n, 0.42, e).r * 0.8 * reef;
}

/**
 * Bump from world-space finite differences of the relief. Screen-space
 * derivatives are constant over 2x2 pixel quads, which turns fine relief into
 * a checkerboard; explicit taps a pixel-footprint apart stay smooth.
 */
fn rockBump(n: vec3f, p: vec3f, reef: f32, strength: f32, footprint: f32) -> vec3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.x) > 0.7);
  let t1 = normalize(cross(n, a));
  let t2 = cross(n, t1);
  let e = footprint;
  let h0 = rockRelief(p, n, reef, e);
  let h1 = rockRelief(p + t1 * e, n, reef, e);
  let h2 = rockRelief(p + t2 * e, n, reef, e);
  let g = (t1 * (h1 - h0) + t2 * (h2 - h0)) / e;
  return normalize(n - g * strength);
}

struct FOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
};

/**
 * The seabed surface at a point: sand, rock, reef rubble and growth, blended
 * from the terrain masks and the detail texture. Shared by the height-map
 * terrain and the volumetric one, which differ only in where the geometry and
 * the normal come from.
 */
fn terrainSurface(p: vec3f, nIn: vec3f, m: vec4f, aoIn: f32) -> Surface {
  var n = nIn;
  let rockAmt = m.r;
  let mossAmt = m.a;

  // Detail layers.
  let broad = textureSample(tDetail, sLinearRepeat, p.xz * 0.02);
  let tri = triplanar(p, n, 0.13);
  let triFine = triplanar(p, n, 0.55);
  let sandDetail = textureSample(tDetail, sLinearRepeat, p.xz * 0.09);

  // Blend weight with a noisy edge so sand drifts over rock naturally.
  // (Smooth fbm for the edge noise: the cell channel gives giraffe patterns.)
  let rockW = smoothstep(0.35, 0.65, rockAmt + (tri.r - 0.5) * 0.5 + (broad.r - 0.5) * 0.3);

  // Sand: ripple normals (strength fades on slopes), warm variation.
  // Ripples vary in strength across the floor so they don't read as a pattern.
  let camDist = length(p - frame.camPos);
  // Beyond ~25m ripples would alias into a regular stripe pattern: fade them.
  let rippleStrength = (1.0 - rockW) * smoothstep(0.3, 0.05, 1.0 - n.y) *
    smoothstep(0.25, 0.7, broad.g + broad.r * 0.4) * mix(1.0, 0.15, smoothstep(15.0, 40.0, camDist));
  let e = 0.22;
  let r0 = textureSample(tDetail, sLinearRepeat, p.xz * 0.07).b;
  let rx = textureSample(tDetail, sLinearRepeat, (p.xz + vec2f(e, 0.0)) * 0.07).b;
  let rz = textureSample(tDetail, sLinearRepeat, (p.xz + vec2f(0.0, e)) * 0.07).b;
  let f0s = textureSample(tDetail, sLinearRepeat, p.zx * 0.31).b;
  let fxs = textureSample(tDetail, sLinearRepeat, (p.zx + vec2f(e * 0.25, 0.0)) * 0.31).b;
  let fzs = textureSample(tDetail, sLinearRepeat, (p.zx + vec2f(0.0, e * 0.25)) * 0.31).b;
  let sandGrad = vec2f(rx - r0, rz - r0) * rippleStrength * 0.8 +
    vec2f(fzs - f0s, fxs - f0s) * (1.0 - rockW) * 0.5;

  // Rock: crack/cell pattern.
  let c0 = tri.g;

  let sandN = normalize(vec3f(n.x - sandGrad.x, n.y, n.z - sandGrad.y));
  // Rock normal: perturb along noise-derived tangent directions.
  // Rock relief: layered height from the detail textures, as a true bump map.
  // (The detail texture's blue channel is sand ripples: keep it off rock.)
  // (Fine grain stays out of the bump: at a distance it becomes pixel noise.)
  let reefAmt = smoothstep(0.3, 0.7, m.g) * rockW;
  // A pixel's footprint stretches at grazing angles; widen the taps to match.
  let grazing = max(abs(dot(n, normalize(frame.camPos - p))), 0.15);
  let rockN = rockBump(n, p, reefAmt, 0.26, clamp(camDist * 0.004 / sqrt(grazing), 0.04, 0.6));
  n = normalize(mix(sandN, rockN, rockW));

  // Sand: warm, with darker patches of debris and fine speckle.
  let speckle = smoothstep(0.62, 0.75, triFine.a);
  var sandCol = mix(vec3f(0.62, 0.53, 0.40), vec3f(0.86, 0.78, 0.62), smoothstep(0.25, 0.75, broad.r));
  sandCol *= (0.9 + 0.2 * sandDetail.a) * mix(0.94 + 0.1 * r0, 0.99, smoothstep(15.0, 40.0, camDist)) * (1.0 - speckle * 0.35);
  // Rock: dark stone, crevices darker still.
  // Layered stone tones from smooth noise (no cell pattern, which tiles into a honeycomb).
  var rockCol = mix(vec3f(0.17, 0.15, 0.13), vec3f(0.36, 0.32, 0.27), tri.r) * (0.8 + 0.25 * triFine.r);
  rockCol *= mix(0.78, 1.0, smoothstep(0.25, 0.75, broad.r * 0.7 + triFine.a * 0.3));
  // Encrusting growth: green algae, pink/orange coralline algae, purple sponge.
  let hueSel = triplanar(p, n, 0.045).r;
  // Short algal turf is olive-brown, not lawn green.
  let algae = vec3f(0.21, 0.21, 0.1);
  let coralline = vec3f(0.5, 0.33, 0.3);
  let sponge = vec3f(0.34, 0.17, 0.36);
  var growth = mix(algae, coralline, smoothstep(0.42, 0.58, hueSel));
  growth = mix(growth, sponge, smoothstep(0.62, 0.72, hueSel) * 0.8);
  growth *= 0.85 + 0.3 * triFine.r;
  let growthAmt = clamp((mossAmt + 0.25) * smoothstep(0.3, 0.75, tri.r * 0.75 + triFine.r * 0.25 + broad.r * 0.4) * smoothstep(0.2, 0.6, n.y), 0.0, 0.9);
  rockCol = mix(rockCol, growth, growthAmt);

  // Reef zones: a carpet of coral rubble, not felt. Lumpy broken fragments
  // (pale, bleached pieces among darker turf-covered ones) with bare gaps.
  let rubbleField = triplanar(p, n, 0.42);
  let lump = smoothstep(0.35, 0.7, rubbleField.r * 0.7 + tri.r * 0.3);
  let fragment = smoothstep(0.66, 0.76, triplanar(p, n, 0.9).r) * smoothstep(0.4, 0.9, n.y);
  let turfCol = mix(vec3f(0.2, 0.19, 0.1), vec3f(0.3, 0.25, 0.13), triFine.r);
  var reefCol = mix(rockCol * 0.8, turfCol, lump * 0.8);
  reefCol = mix(reefCol, vec3f(0.66, 0.62, 0.54) * (0.8 + 0.3 * rubbleField.b), fragment * 0.7);
  rockCol = mix(rockCol, reefCol, reefAmt);
  // Close-range grit: small pebbles, shell fragments and turf tufts break up
  // the broad colour fields (mipmapping fades it out with distance).
  let micro = triplanar(p, n, 2.3);
  rockCol *= 0.78 + 0.44 * micro.r;
  rockCol = mix(rockCol, vec3f(0.62, 0.58, 0.5), smoothstep(0.74, 0.84, micro.a) * 0.5);
  rockCol = mix(rockCol, rockCol * 0.45, smoothstep(0.3, 0.18, micro.r) * 0.6);

  var s = defaultSurface();
  s.albedo = mix(sandCol, rockCol, rockW);
  s.roughness = mix(0.92, 0.75, rockW);
  s.normal = n;
  s.ao = aoIn * mix(1.0, 0.6 + 0.4 * smoothstep(0.2, 0.7, tri.r), rockW);
  s.f0 = 0.03;
  return s;
}
`;

const renderShader = /* wgsl */ `
${surfaceLib}
${propsWgsl}

struct Grid { count: u32, worldSize: f32 };
@group(1) @binding(0) var<uniform> grid: Grid;
/**
 * Visible terrain chunks: xy = first grid cell, z = cell step (detail level),
 * w = cells per chunk side at that step.
 */
@group(1) @binding(1) var<storage, read> chunks: array<vec4f>;

/** Grid position (0..1 across the whole grid) and skirt flag for a chunk vertex. */
fn chunkVertex(vi: u32, ii: u32) -> vec3f {
  let c = chunks[ii];
  let cells = u32(c.w);
  let n = cells + 1u;
  var lx: u32;
  var lz: u32;
  var skirt = 0.0;
  if (vi < n * n) {
    lx = vi % n;
    lz = vi / n;
  } else {
    // Skirt: a copy of the edge ring, dropped down to hide cracks between
    // neighbouring chunks at different detail levels.
    let k = vi - n * n;
    let m = cells;
    if (k < m) { lx = k; lz = 0u; }
    else if (k < 2u * m) { lx = m; lz = k - m; }
    else if (k < 3u * m) { lx = m - (k - 2u * m); lz = m; }
    else { lx = 0u; lz = m - (k - 3u * m); }
    skirt = 1.0;
  }
  let gx = (c.x + f32(lx) * c.z) / f32(grid.count);
  let gz = (c.y + f32(lz) * c.z) / f32(grid.count);
  return vec3f(gx, gz, skirt * c.z);
}

/** World position of a chunk vertex (the grid is denser near the middle). */
fn chunkWorld(vi: u32, ii: u32) -> vec3f {
  let cv = chunkVertex(vi, ii);
  let g = cv.xy * 2.0 - 1.0;
  let warped = sign(g) * pow(abs(g), vec2f(1.6));
  let xz = warped * grid.worldSize * 0.5;
  let h = textureSampleLevel(tTerrain, sLinearClamp, xz / frame.terrain.x + 0.5, 0.0).r;
  return vec3f(xz.x, h - cv.z * 0.35, xz.y);
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) prevClip: vec4f,
  @location(3) curClip: vec4f,
};

fn terrainUv(xz: vec2f) -> vec2f {
  return xz / frame.terrain.x + 0.5;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let world = chunkWorld(vi, ii);
  let uv = terrainUv(world.xz);
  var o: VOut;
  o.pos = frame.viewProj * vec4f(world, 1.0);
  o.world = world;
  o.uv = uv;
  o.curClip = frame.viewProjNoJitter * vec4f(world, 1.0);
  o.prevClip = frame.prevViewProjNoJitter * vec4f(world, 1.0);
  return o;
}

${terrainMaterialWgsl}

@fragment
fn fs(i: VOut) -> FOut {
  let t = textureSample(tTerrain, sLinearClamp, i.uv);
  let m = textureSample(tTerrainMask, sLinearClamp, i.uv);
  var n = normalize(vec3f(t.g, sqrt(max(1.0 - t.g * t.g - t.b * t.b, 0.0)), t.b));
  let p = i.world;

  let s = terrainSurface(p, n, m, t.a);

  let lit = shadeSurface(s, p, -1.0);
  var o: FOut;
  o.color = vec4f(applyWater(lit, p), 1.0);
  o.velocity = (i.curClip.xy / i.curClip.w - i.prevClip.xy / i.prevClip.w) * vec2f(0.5, -0.5);
  return o;
}

@vertex
fn vsShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return frame.shadowViewProj * vec4f(chunkWorld(vi, ii), 1.0);
}
`;

export interface TerrainRenderer {
  /** Picks visible chunks and their detail levels for this frame. */
  update(view: CullView): void;
  draw(pass: GPURenderPassEncoder): void;
  drawShadow(pass: GPURenderPassEncoder): void;
}

export async function createTerrainRenderer(
  device: GPUDevice,
  globalsLayout: GPUBindGroupLayout,
  targets: {
    color: GPUTextureFormat;
    velocity: GPUTextureFormat;
    depth: GPUTextureFormat;
  },
  gridCount: number,
  worldSize: number,
  heightAt: (x: number, z: number) => number,
): Promise<TerrainRenderer> {
  const module = createShader(device, 'terrain:render-shader', renderShader);
  const localLayout = device.createBindGroupLayout({
    label: 'terrain:local-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: {type: 'uniform', minBindingSize: 8},
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: {type: 'read-only-storage'},
      },
    ],
  });
  const layout = device.createPipelineLayout({
    label: 'terrain:pipeline-layout',
    bindGroupLayouts: [globalsLayout, localLayout],
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'terrain:pipeline',
    layout,
    vertex: {module, entryPoint: 'vs'},
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [{format: targets.color}, {format: targets.velocity}],
    },
    primitive: {topology: 'triangle-list', cullMode: 'back'},
    depthStencil: {
      format: targets.depth,
      depthWriteEnabled: true,
      depthCompare: 'greater',
    },
  });
  const shadowPipeline = await device.createRenderPipelineAsync({
    label: 'terrain:shadow-pipeline',
    layout,
    vertex: {module, entryPoint: 'vsShadow'},
    primitive: {topology: 'triangle-list', cullMode: 'none'},
    depthStencil: {
      format: 'depth32float',
      depthWriteEnabled: true,
      depthCompare: 'greater',
    },
  });

  const gridBuf = device.createBuffer({
    label: 'terrain:grid-uniform',
    size: 8,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const gridData = new ArrayBuffer(8);
  new Uint32Array(gridData, 0, 1)[0] = gridCount;
  new Float32Array(gridData, 4, 1)[0] = worldSize;
  device.queue.writeBuffer(gridBuf, 0, gridData);

  // --- Chunks ---
  // The grid is split into square chunks; each is drawn at one of several
  // detail levels (cell steps 1, 2, 4, 8) as an instance of that level's
  // shared index buffer.
  const CHUNK = Math.min(32, gridCount);
  const perSide = Math.ceil(gridCount / CHUNK);
  const steps = [1, 2, 4, 8].filter(st => st <= CHUNK);
  const warp = (g: number) => Math.sign(g) * Math.pow(Math.abs(g), 1.6);
  const chunkInfo: {
    ix: number;
    iz: number;
    cells: number;
    min: [number, number, number];
    max: [number, number, number];
  }[] = [];
  for (let cz = 0; cz < perSide; cz++) {
    for (let cx = 0; cx < perSide; cx++) {
      const ix = cx * CHUNK;
      const iz = cz * CHUNK;
      const cells = Math.min(CHUNK, gridCount - ix, gridCount - iz);
      const x0 = warp((ix / gridCount) * 2 - 1) * worldSize * 0.5;
      const x1 = warp(((ix + cells) / gridCount) * 2 - 1) * worldSize * 0.5;
      const z0 = warp((iz / gridCount) * 2 - 1) * worldSize * 0.5;
      const z1 = warp(((iz + cells) / gridCount) * 2 - 1) * worldSize * 0.5;
      // Every cell corner, not a coarse sample of them: canyon walls put
      // metres of height inside one chunk, and a bound that misses them
      // culls chunks that are still on screen.
      let hMin = Infinity;
      let hMax = -Infinity;
      for (let sz = 0; sz <= cells; sz++) {
        for (let sx = 0; sx <= cells; sx++) {
          const h = heightAt(
            x0 + ((x1 - x0) * sx) / cells,
            z0 + ((z1 - z0) * sz) / cells,
          );
          hMin = Math.min(hMin, h);
          hMax = Math.max(hMax, h);
        }
      }
      chunkInfo.push({
        ix,
        iz,
        cells,
        // Margin for the skirts that hide the seams between levels.
        min: [Math.min(x0, x1), hMin - 3.5, Math.min(z0, z1)],
        max: [Math.max(x0, x1), hMax + 0.5, Math.max(z0, z1)],
      });
    }
  }

  // One index buffer per level (a full chunk of CHUNK cells), with skirts.
  const levelIndex: {buf: GPUBuffer; count: number; cells: number}[] =
    steps.map(step => {
      const cells = CHUNK / step;
      const n = cells + 1;
      const idx: number[] = [];
      for (let z = 0; z < cells; z++) {
        for (let x = 0; x < cells; x++) {
          const i0 = z * n + x;
          const i1 = i0 + 1;
          const i2 = i0 + n;
          const i3 = i2 + 1;
          // Counter-clockwise when seen from above (+y).
          idx.push(i0, i2, i1, i1, i2, i3);
        }
      }
      const m = cells;
      const ringTop = (k: number) => {
        k %= 4 * m;
        if (k < m) return k;
        if (k < 2 * m) return (k - m) * n + m;
        if (k < 3 * m) return m * n + (m - (k - 2 * m));
        return (m - (k - 3 * m)) * n;
      };
      for (let k = 0; k < 4 * m; k++) {
        const a = ringTop(k);
        const b = ringTop(k + 1);
        const aDown = n * n + k;
        const bDown = n * n + ((k + 1) % (4 * m));
        // Both windings: skirts are seen from either side.
        idx.push(a, aDown, b, b, aDown, bDown, a, b, aDown, b, bDown, aDown);
      }
      const data = new Uint32Array(idx);
      const buf = device.createBuffer({
        label: `terrain:index-buffer-step${step}`,
        size: data.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, data);
      return {buf, count: data.length, cells};
    });

  const maxChunks = chunkInfo.length * 2;
  const chunkData = new Float32Array(maxChunks * 4);
  const chunkBuf = device.createBuffer({
    label: 'terrain:chunks',
    size: chunkData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const localBindGroup = device.createBindGroup({
    label: 'terrain:local-bind-group',
    layout: localLayout,
    entries: [
      {binding: 0, resource: {buffer: gridBuf}},
      {binding: 1, resource: {buffer: chunkBuf}},
    ],
  });

  // Per pass and level: a contiguous run of instances in the chunk buffer.
  // Edge chunks with fewer cells are drawn at a level whose cell count fits.
  type Run = {first: number; count: number};
  const camRuns: Run[] = steps.map(() => ({first: 0, count: 0}));
  const shadowRuns: Run[] = steps.map(() => ({first: 0, count: 0}));
  const lists: number[][] = steps.map(() => []);
  const shadowLists: number[][] = steps.map(() => []);

  const camPlanes = new Float32Array(16);
  const shadowPlanes = new Float32Array(16);

  return {
    update(view: CullView) {
      const cp = view.camPos;
      sidePlanes(view.viewProj, camPlanes);
      sidePlanes(view.shadowViewProj, shadowPlanes);
      lists.forEach(l => (l.length = 0));
      shadowLists.forEach(l => (l.length = 0));
      chunkInfo.forEach((c, i) => {
        // Distance from the camera to the chunk's box.
        const dx = Math.max(c.min[0] - cp[0], 0, cp[0] - c.max[0]);
        const dy = Math.max(c.min[1] - cp[1], 0, cp[1] - c.max[1]);
        const dz = Math.max(c.min[2] - cp[2], 0, cp[2] - c.max[2]);
        const dist = Math.hypot(dx, dy, dz);
        // Coarser while one cell stays under ~1/40 of the distance (a few pixels).
        const cellWorld = (c.max[0] - c.min[0]) / c.cells;
        const pick = (tolerance: number) => {
          let level = 0;
          while (
            level < steps.length - 1 &&
            c.cells % steps[level + 1] === 0 &&
            cellWorld * steps[level + 1] < Math.max(dist, 0.5) * tolerance
          ) {
            level++;
          }
          return level;
        };
        if (!boxOutside(camPlanes, c.min, c.max)) {
          lists[pick(0.025)].push(i);
        }
        if (!boxOutside(shadowPlanes, c.min, c.max)) {
          shadowLists[pick(0.08)].push(i);
        }
      });
      let cursor = 0;
      const pack = (src: number[][], runs: Run[]) => {
        src.forEach((list, level) => {
          runs[level].first = cursor;
          runs[level].count = 0;
          for (const i of list) {
            const c = chunkInfo[i];
            const cellsAtLevel = c.cells / steps[level];
            // Partial edge chunks: only draw if they tile the level's grid.
            if (cellsAtLevel !== levelIndex[level].cells) {
              continue;
            }
            chunkData.set([c.ix, c.iz, steps[level], cellsAtLevel], cursor * 4);
            cursor++;
            runs[level].count++;
          }
        });
      };
      pack(lists, camRuns);
      pack(shadowLists, shadowRuns);
      if (cursor) {
        device.queue.writeBuffer(chunkBuf, 0, chunkData, 0, cursor * 4);
      }
    },
    draw(pass) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, localBindGroup);
      camRuns.forEach((r, level) => {
        if (r.count) {
          pass.setIndexBuffer(levelIndex[level].buf, 'uint32');
          pass.drawIndexed(levelIndex[level].count, r.count, 0, 0, r.first);
        }
      });
    },
    drawShadow(pass) {
      pass.setPipeline(shadowPipeline);
      pass.setBindGroup(1, localBindGroup);
      shadowRuns.forEach((r, level) => {
        if (r.count) {
          pass.setIndexBuffer(levelIndex[level].buf, 'uint32');
          pass.drawIndexed(levelIndex[level].count, r.count, 0, 0, r.first);
        }
      });
    },
  };
}
