// Screen-space ambient occlusion: grounds props on the sand and darkens
// crevices. A half-resolution compute pass estimates occlusion from the depth
// buffer; a composite pass blurs it (depth-aware) and multiplies it into the
// HDR image, fading with distance so the water itself is never darkened.

import {createShader} from '../gpu/device.ts';
import {fullscreenVS, globals} from '../shaders/index.ts';
import {
  HDR_FORMAT,
  type FrameContext,
  type Renderer,
  type RenderSystem,
  type Targets,
} from './renderer.ts';

const NEAR = 0.05;

const aoShader = /* wgsl */ `
${globals}
@group(1) @binding(0) var tDepth: texture_depth_2d;
@group(1) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;

fn viewPos(p: vec2i, size: vec2f) -> vec3f {
  let d = textureLoad(tDepth, clamp(p, vec2i(0), vec2i(size) - 1), 0);
  let z = -${NEAR} / max(d, 1e-6);
  let uv = (vec2f(p) + 0.5) / size;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return vec3f(ndc.x * -z / frame.proj[0][0], ndc.y * -z / frame.proj[1][1], z);
}

fn hash(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let outSize = textureDimensions(dst);
  if (any(id.xy >= outSize)) {
    return;
  }
  let size = vec2f(textureDimensions(tDepth));
  let scale = size / vec2f(outSize);
  let pix = vec2i((vec2f(id.xy) + 0.5) * scale);
  let d = textureLoad(tDepth, pix, 0);
  if (d <= 0.0) {
    textureStore(dst, id.xy, vec4f(1.0));
    return;
  }
  let P = viewPos(pix, size);
  // Normal from the smaller-gradient neighbours to avoid smearing across edges.
  let px = viewPos(pix + vec2i(1, 0), size) - P;
  let nx = P - viewPos(pix - vec2i(1, 0), size);
  let py = viewPos(pix + vec2i(0, 1), size) - P;
  let ny = P - viewPos(pix - vec2i(0, 1), size);
  let dx = select(nx, px, abs(px.z) < abs(nx.z));
  let dy = select(ny, py, abs(py.z) < abs(ny.z));
  let N = normalize(cross(dy, dx));

  let radius = clamp(-P.z * 0.08, 0.25, 1.2);
  let projScale = frame.proj[1][1] * size.y * 0.5 / -P.z;
  let screenRadius = radius * projScale;
  let rot = hash(vec2f(id.xy) + f32(frame.frameIndex % 16u) * 7.13) * 6.2831853;
  var occlusion = 0.0;
  let count = 12;
  for (var i = 0; i < count; i++) {
    let fi = f32(i);
    let a = rot + fi * 2.39996;
    let r = sqrt((fi + 0.5) / f32(count)) * screenRadius;
    let offset = vec2i(vec2f(cos(a), sin(a)) * max(r, 1.0));
    let S = viewPos(pix + offset, size);
    let v = S - P;
    let dist2 = dot(v, v);
    let ndv = dot(N, v) / sqrt(dist2 + 1e-5);
    let falloff = 1.0 - clamp(dist2 / (radius * radius), 0.0, 1.0);
    occlusion += max(ndv - 0.1, 0.0) * falloff;
  }
  let ao = clamp(1.0 - occlusion / f32(count) * 2.2, 0.0, 1.0);
  textureStore(dst, id.xy, vec4f(ao, -P.z / 100.0, 0.0, 1.0));
}
`;

const compositeShader = /* wgsl */ `
${fullscreenVS}
@group(0) @binding(0) var tAo: texture_2d<f32>;
@group(0) @binding(1) var tDepth: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> fogK: f32;

@fragment
fn fs(i: FSOut) -> @location(0) vec4f {
  let d = textureLoad(tDepth, vec2i(i.pos.xy), 0);
  if (d <= 0.0) {
    return vec4f(1.0);
  }
  let viewZ = ${NEAR} / d;
  let aoSize = vec2f(textureDimensions(tAo));
  let texel = 1.0 / aoSize;
  var sum = 0.0;
  var wsum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let s = textureSampleLevel(tAo, samp, i.uv + vec2f(f32(x), f32(y)) * texel, 0.0);
      let w = 1.0 / (1e-3 + abs(s.g * 100.0 - viewZ) * 2.0);
      sum += s.r * w;
      wsum += w;
    }
  }
  let ao = sum / wsum;
  // Fade out with distance: far surfaces are mostly fog colour anyway.
  let visible = exp(-viewZ * fogK);
  return vec4f(vec3f(mix(1.0, ao, visible)), 1.0);
}
`;

export async function createSsao(renderer: Renderer): Promise<RenderSystem> {
  const device = renderer.device;
  const divisor = renderer.quality.tierIndex >= 2 ? 2 : 3;
  const aoModule = createShader(device, 'ssao:shader', aoShader);
  const aoPipeline = await device.createComputePipelineAsync({
    label: 'ssao:pipeline',
    layout: 'auto',
    compute: {module: aoModule, entryPoint: 'main'},
  });
  const compModule = createShader(
    device,
    'ssao:composite-shader',
    compositeShader,
  );
  const compPipeline = await device.createRenderPipelineAsync({
    label: 'ssao:composite-pipeline',
    layout: 'auto',
    vertex: {module: compModule, entryPoint: 'vsFullscreen'},
    fragment: {
      module: compModule,
      entryPoint: 'fs',
      targets: [
        {
          format: HDR_FORMAT,
          // Multiply: result = destination * source.
          blend: {
            color: {srcFactor: 'zero', dstFactor: 'src', operation: 'add'},
            alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'},
          },
        },
      ],
    },
  });
  const sampler = device.createSampler({
    label: 'ssao:sampler',
    magFilter: 'linear',
    minFilter: 'linear',
  });
  const fogBuf = device.createBuffer({
    label: 'ssao:fog-uniform',
    size: 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(fogBuf, 0, new Float32Array([0.05]));

  let aoTex: GPUTexture | null = null;
  let aoGroup: GPUBindGroup;
  let compGroup: GPUBindGroup;
  let globalsGroup: GPUBindGroup | null = null;
  let lastGlobals: GPUBindGroup | null = null;

  return {
    name: 'ssao',
    resize(t: Targets) {
      aoTex?.destroy();
      aoTex = device.createTexture({
        label: 'ssao:texture',
        size: [Math.ceil(t.width / divisor), Math.ceil(t.height / divisor)],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      const depthView = t.depth.createView({label: 'ssao:depth-view'});
      aoGroup = device.createBindGroup({
        label: 'ssao:bind-group',
        layout: aoPipeline.getBindGroupLayout(1),
        entries: [
          {binding: 0, resource: depthView},
          {
            binding: 1,
            resource: aoTex.createView({label: 'ssao:storage-view'}),
          },
        ],
      });
      compGroup = device.createBindGroup({
        label: 'ssao:composite-bind-group',
        layout: compPipeline.getBindGroupLayout(0),
        entries: [
          {binding: 0, resource: aoTex.createView({label: 'ssao:sample-view'})},
          {binding: 1, resource: depthView},
          {binding: 2, resource: sampler},
          {binding: 3, resource: {buffer: fogBuf}},
        ],
      });
    },
    afterOpaque(ctx: FrameContext) {
      if (!aoTex) {
        return;
      }
      if (lastGlobals !== ctx.globals) {
        lastGlobals = ctx.globals;
        globalsGroup = device.createBindGroup({
          label: 'ssao:globals-bind-group',
          layout: aoPipeline.getBindGroupLayout(0),
          entries: [{binding: 0, resource: {buffer: renderer.globals.buffer}}],
        });
      }
      const cpass = ctx.encoder.beginComputePass({label: 'ssao:pass'});
      cpass.setPipeline(aoPipeline);
      cpass.setBindGroup(0, globalsGroup!);
      cpass.setBindGroup(1, aoGroup);
      cpass.dispatchWorkgroups(
        Math.ceil(aoTex.width / 8),
        Math.ceil(aoTex.height / 8),
      );
      cpass.end();
      const pass = ctx.encoder.beginRenderPass({
        label: 'ssao:composite-pass',
        colorAttachments: [
          {view: ctx.targets.color, loadOp: 'load', storeOp: 'store'},
        ],
      });
      pass.setPipeline(compPipeline);
      pass.setBindGroup(0, compGroup);
      pass.draw(3);
      pass.end();
    },
  };
}
