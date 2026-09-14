// Contact occlusion: a top-down map of how much the props block the sky and
// the sun's scattered light right around where they meet the ground. Sand
// darkens under and beside rocks and coral, and fades back out with distance,
// so objects sit in the seabed rather than on it.

import {createShader} from '../gpu/device.ts';

/** One prop's footprint on the ground, in world units. */
export interface Footprint {
  x: number;
  z: number;
  /** Radius of the part touching (or hanging over) the ground. */
  radius: number;
  /** How tall it rises: taller props shade further out. */
  height: number;
}

/**
 * Rasterizes footprints into a visibility map (1 = open sky, 0 = fully
 * occluded) covering the terrain's world square, and uploads it as an r8 texture.
 */
export function createContactMap(
  device: GPUDevice,
  footprints: Footprint[],
  worldSize: number,
  size: number,
): GPUTexture {
  const vis = new Float32Array(size * size).fill(1);
  const texel = worldSize / size;
  for (const f of footprints) {
    if (f.radius < texel * 0.5) {
      continue;
    }
    const h = Math.max(f.height, f.radius * 0.3);
    // Occlusion reaches out about one prop height beyond the edge.
    const reach = f.radius + Math.min(0.15 + h * 1.6, 5);
    const cx = (f.x / worldSize + 0.5) * size;
    const cz = (f.z / worldSize + 0.5) * size;
    const r = reach / texel;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(size - 1, Math.ceil(cx + r));
    const z0 = Math.max(0, Math.floor(cz - r));
    const z1 = Math.min(size - 1, Math.ceil(cz + r));
    // Strength: squat pads occlude a thin rim; tall heads shade a wide ring.
    const strength = Math.min(0.9, 0.6 + (h / (f.radius + 0.05)) * 0.25);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot((x + 0.5 - cx) * texel, (z + 0.5 - cz) * texel);
        if (d > reach) {
          continue;
        }
        let occ: number;
        if (d < f.radius) {
          // Under the prop: strongest at its edge where the crevice is.
          occ = strength * (0.8 + 0.2 * (d / f.radius));
        } else {
          // Outside: the fraction of sky the prop's side blocks falls off with distance.
          const out = d - f.radius;
          const falloff = h / (h + out * 1.6);
          const edge = 1 - out / (reach - f.radius);
          occ = strength * falloff * Math.min(1, edge * 2.5);
        }
        const i = z * size + x;
        vis[i] *= 1 - occ;
      }
    }
  }
  const data = new Uint8Array(size * size);
  for (let i = 0; i < vis.length; i++) {
    data[i] = Math.round(Math.max(0.08, vis[i]) * 255);
  }
  const texture = device.createTexture({
    label: 'contact:texture',
    size: [size, size],
    format: 'r8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.writeTexture({texture}, data, {bytesPerRow: size}, [size, size]);
  blurContactMap(device, texture);
  return texture;
}

/** A small separable blur on the GPU so stamped edges are soft. */
function blurContactMap(device: GPUDevice, texture: GPUTexture) {
  const module = createShader(
    device,
    'contact:blur-shader',
    /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> dir: vec2i;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(src));
  let p = vec2i(pos.xy);
  let w = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);
  var sum = 0.0;
  for (var k = -2; k <= 2; k++) {
    sum += textureLoad(src, clamp(p + dir * k, vec2i(0), size - 1), 0).r * w[k + 2];
  }
  return vec4f(sum, 0.0, 0.0, 1.0);
}
`,
  );
  const pipeline = device.createRenderPipeline({
    label: 'contact:blur-pipeline',
    layout: 'auto',
    vertex: {module, entryPoint: 'vs'},
    fragment: {module, entryPoint: 'fs', targets: [{format: 'r8unorm'}]},
  });
  const temp = device.createTexture({
    label: 'contact:blur-temp',
    size: [texture.width, texture.height],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const encoder = device.createCommandEncoder({label: 'contact:blur-encoder'});
  const pass = (src: GPUTexture, dst: GPUTexture, d: [number, number]) => {
    const buf = device.createBuffer({
      label: 'contact:blur-dir',
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, new Int32Array(d));
    const group = device.createBindGroup({
      label: 'contact:blur-bind-group',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: src.createView({label: 'contact:blur-src'})},
        {binding: 1, resource: {buffer: buf}},
      ],
    });
    const rp = encoder.beginRenderPass({
      label: 'contact:blur-pass',
      colorAttachments: [
        {
          view: dst.createView({label: 'contact:blur-dst'}),
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    rp.setPipeline(pipeline);
    rp.setBindGroup(0, group);
    rp.draw(3);
    rp.end();
  };
  pass(texture, temp, [1, 0]);
  pass(temp, texture, [0, 1]);
  device.queue.submit([encoder.finish({label: 'contact:blur-commands'})]);
}
