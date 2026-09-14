// Marine snow and bubble streams. Both are computed entirely in the vertex
// shader from per-particle hashes and time, so there is no simulation state.

import {createShader} from '../gpu/device.ts';
import {surfaceLib} from '../shaders/index.ts';
import {DEPTH_FORMAT, HDR_FORMAT, type Renderer, type RenderSystem} from './renderer.ts';
import type {GenContext} from '../world/layout.ts';

const shader = /* wgsl */ `
${surfaceLib}

struct Emitter {
  pos: vec3f,
  rate: f32,
};
struct Params {
  snowCount: u32,
  bubbleCount: u32,
  emitterCount: u32,
  box: f32,
};
@group(1) @binding(0) var<uniform> params: Params;
@group(1) @binding(1) var<storage, read> emitters: array<Emitter>;
@group(1) @binding(2) var tDepth: texture_depth_2d;

fn hash3u(i: u32) -> vec3f {
  return vec3f(pcg3d(vec3u(i, i * 7u + 13u, i * 31u + 7u))) / 4294967295.0;
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) quad: vec2f,
  @location(1) color: vec3f,
  @location(2) alpha: f32,
  @location(3) @interpolate(flat) kind: u32,
  @location(4) viewDepth: f32,
};

fn cornerOf(vi: u32) -> vec2f {
  return vec2f(f32(vi & 1u) * 2.0 - 1.0, f32((vi >> 1u) & 1u) * 2.0 - 1.0);
}

fn billboard(center: vec3f, size: f32, corner: vec2f) -> vec4f {
  let right = vec3f(frame.view[0][0], frame.view[1][0], frame.view[2][0]);
  let up = vec3f(frame.view[0][1], frame.view[1][1], frame.view[2][1]);
  return frame.viewProj * vec4f(center + (right * corner.x + up * corner.y) * size, 1.0);
}

@vertex
fn vsSnow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let h = hash3u(ii);
  let box = params.box;
  // Slow drift with the current and a gentle sink; wrap in a box around the camera.
  let drift = vec3f(0.12, -0.03 - h.y * 0.05, 0.05) * frame.time +
    vec3f(sin(frame.time * 0.3 + h.x * 20.0), cos(frame.time * 0.23 + h.z * 20.0), sin(frame.time * 0.27 + h.y * 20.0)) * 0.15;
  let rel = fract((h * box + drift - frame.camPos) / box) * box - box * 0.5;
  let p = frame.camPos + rel;
  let dist = length(rel);
  let corner = cornerOf(vi);
  // Never smaller than about a pixel so distant flecks don't shimmer.
  let pixel = dist * 2.0 / (frame.proj[1][1] * frame.resolution.y);
  let size = max(0.004 + h.x * 0.008, pixel * 1.2);
  var o: VOut;
  o.pos = billboard(p, size, corner);
  o.quad = corner;
  let edgeFade = smoothstep(box * 0.5, box * 0.3, dist) * smoothstep(0.15, 0.6, dist);
  let light = sunAtDepth(p.y) * (0.4 + waterPhase(dot(normalize(rel), frame.sunDir)) * 3.0) + ambientAtDepth(p.y);
  o.color = light * (0.25 + 0.5 * h.z);
  o.alpha = edgeFade * exp(-dist * 0.08) * min(1.0, (0.006 + h.x * 0.008) / size) * 0.5;
  o.kind = 0u;
  o.viewDepth = -(frame.view * vec4f(p, 1.0)).z;
  return o;
}

@vertex
fn vsBubble(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let h = hash3u(ii + 100003u);
  let e = emitters[ii % params.emitterCount];
  let rise = 0.35 + h.x * 0.3;
  let height = max(frame.surfaceY - e.pos.y, 1.0);
  let period = height / rise;
  let t = fract(frame.time / period * e.rate + h.y);
  let y = e.pos.y + t * height;
  let wob = vec3f(sin(frame.time * 6.0 + h.z * 30.0), 0.0, cos(frame.time * 5.0 + h.x * 30.0)) * 0.02 +
    vec3f(sin(t * 9.0 + h.z * 6.0), 0.0, cos(t * 7.0 + h.x * 6.0)) * 0.25 * t;
  let p = vec3f(e.pos.x, y, e.pos.z) + wob + (h - 0.5) * vec3f(0.12, 0.0, 0.12);
  // Bubbles grow as they rise (less pressure).
  let size = (0.004 + h.z * 0.01) * (1.0 + t * 0.8);
  let corner = cornerOf(vi);
  var o: VOut;
  o.pos = billboard(p, size, corner);
  o.quad = corner;
  let dist = length(p - frame.camPos);
  o.color = sunAtDepth(p.y) * 0.8 + ambientAtDepth(p.y) * 1.5;
  o.alpha = smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.97, t) * exp(-dist * 0.05);
  o.kind = 1u;
  o.viewDepth = -(frame.view * vec4f(p, 1.0)).z;
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let r2 = dot(i.quad, i.quad);
  if (r2 > 1.0) {
    discard;
  }
  // Soft particles: fade where they meet geometry.
  let d = textureLoad(tDepth, vec2i(i.pos.xy), 0);
  let sceneDepth = select(1e4, 0.05 / max(d, 1e-7), d > 0.0);
  let soft = clamp((sceneDepth - i.viewDepth) * 4.0, 0.0, 1.0);
  if (i.kind == 0u) {
    let a = (1.0 - r2) * i.alpha * soft;
    return vec4f(i.color * a, a * 0.5);
  }
  // Bubble: bright Fresnel rim and a specular glint, nearly clear centre.
  let r = sqrt(r2);
  let rim = smoothstep(0.55, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
  let glint = smoothstep(0.25, 0.0, length(i.quad - vec2f(-0.35, 0.35)));
  let a = (rim * 0.8 + glint + 0.06) * i.alpha * soft;
  return vec4f(i.color * (rim * 0.9 + glint * 3.0 + 0.1) * i.alpha * soft, a * 0.6);
}
`;

export async function createParticles(renderer: Renderer, ctx: GenContext): Promise<RenderSystem> {
  const device = renderer.device;
  const rng = ctx.rng('particles');
  const snowCount = Math.round(4000 * ctx.quality.density);

  // Bubble emitters: vents among rocks, the odd anemone bed, and cluster edges.
  const emitters: number[] = [];
  const addEmitter = (x: number, z: number, rate: number) => {
    emitters.push(x, ctx.surfaceTop(x, z) + 0.05, z, rate);
  };
  for (const c of ctx.clusters) {
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      addEmitter(c.x + rng.range(-c.radius, c.radius), c.z + rng.range(-c.radius, c.radius), rng.range(0.6, 1.4));
    }
  }
  for (const a of ctx.anemones.slice(0, 4)) {
    addEmitter(a[0] + rng.range(-0.5, 0.5), a[2] + rng.range(-0.5, 0.5), rng.range(0.3, 0.8));
  }
  if (!emitters.length) {
    addEmitter(0, 0, 1);
  }
  const emitterCount = emitters.length / 4;
  const bubbleCount = Math.round(emitterCount * 40 * Math.max(0.5, ctx.quality.density));

  const module = createShader(device, 'particles:shader', shader);
  const localLayout = device.createBindGroupLayout({
    label: 'particles:local-bgl',
    entries: [
      {binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {type: 'uniform'}},
      {binding: 1, visibility: GPUShaderStage.VERTEX, buffer: {type: 'read-only-storage'}},
      {binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: 'depth'}},
    ],
  });
  const layout = device.createPipelineLayout({
    label: 'particles:pipeline-layout',
    bindGroupLayouts: [renderer.globals.layout, localLayout],
  });
  const blend: GPUBlendState = {
    color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
    alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'},
  };
  const make = (entry: string, label: string) =>
    device.createRenderPipelineAsync({
      label,
      layout,
      vertex: {module, entryPoint: entry},
      fragment: {module, entryPoint: 'fs', targets: [{format: HDR_FORMAT, blend}]},
      primitive: {topology: 'triangle-strip'},
      depthStencil: {format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater'},
    });
  const [snowPipeline, bubblePipeline] = await Promise.all([
    make('vsSnow', 'particles:snow-pipeline'),
    make('vsBubble', 'particles:bubble-pipeline'),
  ]);

  const paramBuf = device.createBuffer({
    label: 'particles:params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const p = new ArrayBuffer(16);
  new Uint32Array(p, 0, 3).set([snowCount, bubbleCount, emitterCount]);
  new Float32Array(p, 12, 1)[0] = 24;
  device.queue.writeBuffer(paramBuf, 0, p);
  const emitterBuf = device.createBuffer({
    label: 'particles:emitters',
    size: emitters.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(emitterBuf, 0, new Float32Array(emitters));

  // The depth texture is read here while attached read-only in the transparent pass.
  let bindGroup: GPUBindGroup | null = null;
  return {
    name: 'particles',
    resize(t) {
      bindGroup = device.createBindGroup({
        label: 'particles:bind-group',
        layout: localLayout,
        entries: [
          {binding: 0, resource: {buffer: paramBuf}},
          {binding: 1, resource: {buffer: emitterBuf}},
          {binding: 2, resource: t.depth.createView({label: 'particles:depth-view'})},
        ],
      });
    },
    drawTransparent(pass) {
      if (!bindGroup) {
        return;
      }
      pass.setBindGroup(1, bindGroup);
      pass.setPipeline(snowPipeline);
      pass.draw(4, snowCount);
      pass.setPipeline(bubblePipeline);
      pass.draw(4, bubbleCount);
    },
  };
}
