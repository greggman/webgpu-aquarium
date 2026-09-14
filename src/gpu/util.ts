// Small WebGPU helpers: mip generation, compute dispatch, readback.

import {createShader} from './device.ts';
import {fullscreenVS} from '../shaders/index.ts';

export const mipCount = (w: number, h = w) =>
  Math.floor(Math.log2(Math.max(w, h))) + 1;

const mipPipelines = new WeakMap<GPUDevice, Map<string, GPURenderPipeline>>();

function mipPipeline(device: GPUDevice, format: GPUTextureFormat) {
  let cache = mipPipelines.get(device);
  if (!cache) {
    cache = new Map();
    mipPipelines.set(device, cache);
  }
  let pipeline = cache.get(format);
  if (!pipeline) {
    const module = createShader(
      device,
      `mips:shader:${format}`,
      `${fullscreenVS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fs(i: FSOut) -> @location(0) vec4f {
  return textureSampleLevel(src, samp, i.uv, 0.0);
}`,
    );
    pipeline = device.createRenderPipeline({
      label: `mips:pipeline:${format}`,
      layout: 'auto',
      vertex: {module, entryPoint: 'vsFullscreen'},
      fragment: {module, entryPoint: 'fs', targets: [{format}]},
    });
    cache.set(format, pipeline);
  }
  return pipeline;
}

/** Fills mip levels 1..N of a 2D texture by successive linear downsampling. */
export class MipGenerator {
  private levels: {bindGroup: GPUBindGroup; view: GPUTextureView}[] = [];
  private pipeline: GPURenderPipeline;
  private texture: GPUTexture;

  constructor(device: GPUDevice, texture: GPUTexture) {
    this.texture = texture;
    this.pipeline = mipPipeline(device, texture.format);
    const sampler = device.createSampler({
      label: `mips:sampler:${texture.label}`,
      minFilter: 'linear',
      magFilter: 'linear',
    });
    for (let level = 1; level < texture.mipLevelCount; level++) {
      this.levels.push({
        bindGroup: device.createBindGroup({
          label: `mips:bind-group:${texture.label}:${level}`,
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: texture.createView({
                label: `mips:src-view:${texture.label}:${level - 1}`,
                baseMipLevel: level - 1,
                mipLevelCount: 1,
              }),
            },
            {binding: 1, resource: sampler},
          ],
        }),
        view: texture.createView({
          label: `mips:dst-view:${texture.label}:${level}`,
          baseMipLevel: level,
          mipLevelCount: 1,
        }),
      });
    }
  }

  run(encoder: GPUCommandEncoder) {
    this.levels.forEach((l, i) => {
      const pass = encoder.beginRenderPass({
        label: `mips:pass:${this.texture.label}:${i + 1}`,
        colorAttachments: [{view: l.view, loadOp: 'clear', storeOp: 'store'}],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, l.bindGroup);
      pass.draw(3);
      pass.end();
    });
  }
}

export function generateMips(device: GPUDevice, texture: GPUTexture) {
  const encoder = device.createCommandEncoder({
    label: `mips:encoder:${texture.label}`,
  });
  new MipGenerator(device, texture).run(encoder);
  device.queue.submit([
    encoder.finish({label: `mips:commands:${texture.label}`}),
  ]);
}

/** Runs one compute pass over an `x` by `y` grid with 8x8 workgroups. */
export function dispatch2D(
  device: GPUDevice,
  label: string,
  pipeline: GPUComputePipeline,
  bindGroups: GPUBindGroup[],
  x: number,
  y: number,
) {
  const encoder = device.createCommandEncoder({label: `${label}:encoder`});
  const pass = encoder.beginComputePass({label: `${label}:pass`});
  pass.setPipeline(pipeline);
  bindGroups.forEach((bg, i) => pass.setBindGroup(i, bg));
  pass.dispatchWorkgroups(Math.ceil(x / 8), Math.ceil(y / 8));
  pass.end();
  device.queue.submit([encoder.finish({label: `${label}:commands`})]);
}

/** Copies a GPU buffer to the CPU. */
export async function readBuffer(
  device: GPUDevice,
  src: GPUBuffer,
  size = src.size,
): Promise<ArrayBuffer> {
  const staging = device.createBuffer({
    label: `${src.label}:readback`,
    size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder({
    label: `${src.label}:readback-encoder`,
  });
  encoder.copyBufferToBuffer(src, 0, staging, 0, size);
  device.queue.submit([
    encoder.finish({label: `${src.label}:readback-commands`}),
  ]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return copy;
}

export function createUniformBuffer(
  device: GPUDevice,
  label: string,
  data: ArrayBuffer | ArrayBufferView,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(16, Math.ceil(data.byteLength / 4) * 4),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data as ArrayBuffer);
  return buffer;
}

/** A 1x1 texture filled with a constant, for bindings whose real texture comes later. */
export function createSolidTexture(
  device: GPUDevice,
  label: string,
  format: GPUTextureFormat,
  value: number[],
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [1, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  if (format === 'rgba16float') {
    const half = new Uint16Array(4);
    for (let i = 0; i < 4; i++) {
      half[i] = toHalf(value[i]);
    }
    device.queue.writeTexture({texture}, half, {bytesPerRow: 8}, [1, 1]);
  } else {
    const data = new Uint8Array(value.map(v => Math.round(v * 255)));
    device.queue.writeTexture({texture}, data, {bytesPerRow: 4}, [1, 1]);
  }
  return texture;
}

function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const i = new Int32Array(f.buffer)[0];
  const sign = (i >> 16) & 0x8000;
  const exp = ((i >> 23) & 0xff) - (127 - 15);
  const mant = (i >> 12) & 0x7ff;
  if (exp <= 0) {
    return sign;
  }
  if (exp >= 31) {
    return sign | 0x7c00;
  }
  return sign | (exp << 10) | (mant >> 1);
}
