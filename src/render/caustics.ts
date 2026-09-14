// Animated caustics computed every frame on the GPU.
//
// Light refracting through the wavy surface is displaced by roughly
// alpha * grad(h). Where that mapping folds (its Jacobian determinant crosses
// zero) light focuses into bright lines; the intensity is 1/|det J|. A slightly
// different alpha per colour channel gives the chromatic fringes.

import {createShader} from '../gpu/device.ts';
import {defineStruct, StructBuffer} from '../gpu/structs.ts';
import {MipGenerator, mipCount} from '../gpu/util.ts';
import type {Rng} from '../core/rng.ts';
import waves from '../shaders/waves.wgsl';
import type {FrameContext, RenderSystem} from './renderer.ts';

export const WAVE_TILE = 7;

export function makeWaves(rng: Rng, tile = WAVE_TILE): Float32Array {
  const out = new Float32Array(48);
  const wind = rng.range(0, Math.PI * 2);
  const used = new Set<string>();
  for (let i = 0; i < 12;) {
    const mag = 2 + Math.pow(rng.float(), 1.4) * 11;
    const dir = wind + rng.normal(0, 0.9);
    const nx = Math.round(Math.cos(dir) * mag);
    const nz = Math.round(Math.sin(dir) * mag);
    const key = `${nx},${nz}`;
    if ((nx === 0 && nz === 0) || used.has(key)) {
      continue;
    }
    used.add(key);
    const kx = (2 * Math.PI * nx) / tile;
    const kz = (2 * Math.PI * nz) / tile;
    const k = Math.hypot(kx, kz);
    const slope = rng.range(0.018, 0.034);
    out.set([kx, kz, slope / k, Math.sqrt(9.81 * k) * 0.95], i * 4);
    i++;
  }
  return out;
}

const Params = defineStruct('CausticParams', {
  waves: 'array<vec4f, 12>',
  time: 'f32',
  tile: 'f32',
  alpha: 'f32',
  size: 'f32',
  phaseSeed: 'f32',
  pad0: 'f32',
  pad1: 'f32',
  pad2: 'f32',
});

const shader = /* wgsl */ `
${Params.wgsl}
@group(0) @binding(0) var<uniform> P: CausticParams;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;

fn waveData(i: u32) -> vec4f { return P.waves[i]; }
fn wavePhaseSeed() -> f32 { return P.phaseSeed; }
${waves}

fn intensity(s: WaveSample, alpha: f32) -> f32 {
  let jxx = 1.0 + alpha * s.hess.x;
  let jzz = 1.0 + alpha * s.hess.z;
  let jxz = alpha * s.hess.y;
  let det = jxx * jzz - jxz * jxz;
  return 1.0 / max(abs(det), 0.08);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = u32(P.size);
  if (any(id.xy >= vec2u(size))) {
    return;
  }
  let xz = (vec2f(id.xy) + 0.5) / P.size * P.tile;
  let s = sampleWaves(xz, P.time);
  let r = intensity(s, P.alpha * 0.94);
  let g = intensity(s, P.alpha);
  let b = intensity(s, P.alpha * 1.06);
  // Compress the long tail so focal lines stay bright but not blown out,
  // and roughly normalise the mean to 1.
  let c = pow(vec3f(r, g, b), vec3f(1.25)) * 0.55;
  textureStore(dst, id.xy, vec4f(c, 1.0));
}
`;

export class Caustics implements RenderSystem {
  name = 'caustics';
  readonly texture: GPUTexture;
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private bindGroup: GPUBindGroup;
  private params = new StructBuffer(Params);
  private paramBuf: GPUBuffer;
  private mips: MipGenerator;
  private size: number;

  constructor(
    device: GPUDevice,
    size: number,
    waveData: Float32Array,
    phaseSeed: number,
  ) {
    this.device = device;
    this.size = size;
    this.texture = device.createTexture({
      label: 'caustics:texture',
      size: [size, size],
      format: 'rgba16float',
      mipLevelCount: mipCount(size),
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const module = createShader(device, 'caustics:shader', shader);
    this.pipeline = device.createComputePipeline({
      label: 'caustics:pipeline',
      layout: 'auto',
      compute: {module, entryPoint: 'main'},
    });
    this.paramBuf = device.createBuffer({
      label: 'caustics:params',
      size: Params.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.params.set('waves', waveData);
    this.params.set('tile', WAVE_TILE);
    this.params.set('alpha', 5.5);
    this.params.set('size', size);
    this.params.set('phaseSeed', phaseSeed);
    this.bindGroup = device.createBindGroup({
      label: 'caustics:bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: {buffer: this.paramBuf}},
        {
          binding: 1,
          resource: this.texture.createView({
            label: 'caustics:mip0-storage-view',
            mipLevelCount: 1,
          }),
        },
      ],
    });
    this.mips = new MipGenerator(device, this.texture);
  }

  update(ctx: FrameContext) {
    this.params.set('time', ctx.time);
    this.device.queue.writeBuffer(this.paramBuf, 0, this.params.data);
    const pass = ctx.encoder.beginComputePass({label: 'caustics:pass'});
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.size / 8), Math.ceil(this.size / 8));
    pass.end();
    this.mips.run(ctx.encoder);
  }
}
