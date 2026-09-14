// Tileable detail textures generated on the GPU.

import {createShader} from '../gpu/device.ts';
import {
  dispatch2D,
  generateMips,
  mipCount,
  createUniformBuffer,
} from '../gpu/util.ts';
import {noise} from '../shaders/index.ts';

const detailShader = /* wgsl */ `
${noise}
struct Params { size: u32, seed: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(params.size))) {
    return;
  }
  noiseSeed = params.seed;
  let uv = (vec2f(id.xy) + 0.5) / f32(params.size);

  // r: broad tileable fbm (albedo variation, moss patches)
  let broad = fbm2p(uv * 8.0, 6, 8) * 0.5 + 0.5;

  // g: rock cells with cracks (worley F2 - F1)
  let w = worley2p(uv * 12.0 + fbm2p(uv * 4.0, 3, 4) * 0.35, vec2i(12));
  let w2 = worley2p(uv * 36.0, vec2i(36));
  let cells = clamp((w.y - w.x) * 2.2, 0.0, 1.0) * 0.7 + clamp((w2.y - w2.x) * 2.0, 0.0, 1.0) * 0.3;

  // b: sand ripples, warped so they wander like real wave ripples
  let warp = fbm2p(uv * 3.0, 4, 3) * 2.2 + fbm2p(uv * 11.0, 2, 11) * 0.25;
  // Whole cycles across the tile in both axes, so the ripples wrap seamlessly.
  let phase = (uv.y + uv.x * 0.2) * 20.0 + warp;
  let ripple = pow(0.5 + 0.5 * sin(phase * 6.2831853), 1.6);

  // a: fine grain
  let grain = fbm2p(uv * 64.0, 3, 64) * 0.5 + 0.5;

  textureStore(dst, id.xy, vec4f(broad, cells, ripple, grain));
}
`;

export function createDetailTexture(
  device: GPUDevice,
  seed: number,
  size = 512,
): GPUTexture {
  const texture = device.createTexture({
    label: 'detail:texture',
    size: [size, size],
    format: 'rgba16float',
    mipLevelCount: mipCount(size),
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const module = createShader(device, 'detail:shader', detailShader);
  const pipeline = device.createComputePipeline({
    label: 'detail:pipeline',
    layout: 'auto',
    compute: {module, entryPoint: 'main'},
  });
  const params = createUniformBuffer(
    device,
    'detail:params',
    new Uint32Array([size, seed]),
  );
  const bindGroup = device.createBindGroup({
    label: 'detail:bind-group',
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      {binding: 0, resource: {buffer: params}},
      {
        binding: 1,
        resource: texture.createView({
          label: 'detail:mip0-view',
          mipLevelCount: 1,
        }),
      },
    ],
  });
  dispatch2D(device, 'detail', pipeline, [bindGroup], size, size);
  generateMips(device, texture);
  return texture;
}
