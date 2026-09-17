// Temporal anti-aliasing: reprojects last frame's result with motion vectors,
// clamps it to the current neighbourhood (variance clipping in YCoCg), and
// blends. Also resolves sub-pixel jitter and noisy effects (volumetrics, PCF).

import {createShader} from '../../gpu/device.ts';
import {fullscreenVS} from '../../shaders/index.ts';
import {
  HDR_FORMAT,
  type FrameContext,
  type PostEffect,
  type Targets,
} from '../renderer.ts';

const shader = /* wgsl */ `
${fullscreenVS}
@group(0) @binding(0) var tCur: texture_2d<f32>;
@group(0) @binding(1) var tHist: texture_2d<f32>;
@group(0) @binding(2) var tVel: texture_2d<f32>;
@group(0) @binding(3) var tDepth: texture_depth_2d;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var<uniform> reset: f32;

fn toYCoCg(c: vec3f) -> vec3f {
  return vec3f(
    dot(c, vec3f(0.25, 0.5, 0.25)),
    dot(c, vec3f(0.5, 0.0, -0.5)),
    dot(c, vec3f(-0.25, 0.5, -0.25)),
  );
}

fn fromYCoCg(c: vec3f) -> vec3f {
  return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

// Compress HDR so a few very bright pixels don't dominate the blend.
fn tonemapW(c: vec3f) -> vec3f {
  return c / (1.0 + max(max(c.r, c.g), c.b));
}

fn untonemapW(c: vec3f) -> vec3f {
  return c / max(1.0 - max(max(c.r, c.g), c.b), 1e-4);
}

// 5-tap Catmull-Rom history sample (Jimenez).
fn sampleHistory(uv: vec2f, size: vec2f) -> vec3f {
  let pos = uv * size;
  let tc = floor(pos - 0.5) + 0.5;
  let f = pos - tc;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let tc0 = (tc - 1.0) / size;
  let tc3 = (tc + 2.0) / size;
  let tc12 = (tc + w2 / w12) / size;
  var c = vec3f(0.0);
  c += textureSampleLevel(tHist, samp, vec2f(tc12.x, tc0.y), 0.0).rgb * (w12.x * w0.y);
  c += textureSampleLevel(tHist, samp, vec2f(tc0.x, tc12.y), 0.0).rgb * (w0.x * w12.y);
  c += textureSampleLevel(tHist, samp, vec2f(tc12.x, tc12.y), 0.0).rgb * (w12.x * w12.y);
  c += textureSampleLevel(tHist, samp, vec2f(tc3.x, tc12.y), 0.0).rgb * (w3.x * w12.y);
  c += textureSampleLevel(tHist, samp, vec2f(tc12.x, tc3.y), 0.0).rgb * (w12.x * w3.y);
  let wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(c / wsum, vec3f(0.0));
}

@fragment
fn fs(i: FSOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(tCur));
  let p = vec2i(i.pos.xy);
  let maxP = vec2i(size) - 1;

  // Neighbourhood statistics and the closest depth's motion vector.
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var bestDepth = -1.0;
  var bestOff = vec2i(0);
  let cur = textureLoad(tCur, p, 0).rgb;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = clamp(p + vec2i(x, y), vec2i(0), maxP);
      let c = toYCoCg(tonemapW(textureLoad(tCur, q, 0).rgb));
      m1 += c;
      m2 += c * c;
      let d = textureLoad(tDepth, q, 0);
      if (d > bestDepth) {
        bestDepth = d;
        bestOff = vec2i(x, y);
      }
    }
  }
  let vel = textureLoad(tVel, clamp(p + bestOff, vec2i(0), maxP), 0).xy;
  let prevUv = i.uv - vel;
  // Stated as the condition for reusing history rather than as the condition
  // for dropping it, so that a non-finite prevUv fails it. Written the other
  // way round (any(prevUv < 0.0) || any(prevUv > 1.0)) both comparisons are
  // false for a NaN, so it would sail through, miss the clip below, and be
  // mixed into the history — which is read back and rewritten every frame
  // after, so one bad fragment latches a texel for good.
  let usable = all(prevUv >= vec2f(0.0)) && all(prevUv <= vec2f(1.0));
  if (reset > 0.5 || !usable) {
    return vec4f(cur, 1.0);
  }

  let mean = m1 / 9.0;
  let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
  // A slightly loose clip lets thin geometry (blades, spines) resolve smoothly
  // instead of re-aliasing every time the history is clamped.
  let gamma = 1.35;
  let lo = mean - sigma * gamma;
  let hi = mean + sigma * gamma;

  let histRgb = sampleHistory(prevUv, size);
  // Second line: a history texel that is already bad (written before this
  // guard existed, or by anything else that gets a pixel wrong) would survive
  // the clip below, since every comparison against a NaN is false.
  if (any(histRgb != histRgb)) {
    return vec4f(cur, 1.0);
  }
  var hist = toYCoCg(tonemapW(histRgb));
  // Clip toward the mean (more accurate than clamping to the box corner).
  let center = (lo + hi) * 0.5;
  let extents = max((hi - lo) * 0.5, vec3f(1e-4));
  let off = hist - center;
  let unit = abs(off / extents);
  let maxUnit = max(unit.x, max(unit.y, unit.z));
  if (maxUnit > 1.0) {
    hist = center + off / maxUnit;
  }

  let curW = toYCoCg(tonemapW(cur));
  // Faster response when moving quickly (less ghosting), slower when still.
  let speed = length(vel * size);
  let alpha = mix(0.07, 0.25, clamp(speed / 8.0, 0.0, 1.0));
  let result = mix(hist, curW, alpha);
  return vec4f(untonemapW(fromYCoCg(result)), 1.0);
}
`;

export async function createTaa(
  device: GPUDevice,
): Promise<PostEffect & {reset(): void}> {
  const module = createShader(device, 'taa:shader', shader);
  const pipeline = await device.createRenderPipelineAsync({
    label: 'taa:pipeline',
    layout: 'auto',
    vertex: {module, entryPoint: 'vsFullscreen'},
    fragment: {module, entryPoint: 'fs', targets: [{format: HDR_FORMAT}]},
  });
  const sampler = device.createSampler({
    label: 'taa:sampler',
    magFilter: 'linear',
    minFilter: 'linear',
  });
  const resetBuf = device.createBuffer({
    label: 'taa:reset-uniform',
    size: 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  let history: GPUTexture[] = [];
  let groups: GPUBindGroup[] = [];
  let current = 0;
  let needsReset = true;

  return {
    name: 'taa',
    reset() {
      needsReset = true;
    },
    resize(t: Targets) {
      history.forEach(h => h.destroy());
      history = [0, 1].map(i =>
        device.createTexture({
          label: `taa:history-${i}`,
          size: [t.width, t.height],
          format: HDR_FORMAT,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
      groups = [0, 1].map(i =>
        device.createBindGroup({
          label: `taa:bind-group-${i}`,
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: t.color.createView({label: 'taa:current-view'}),
            },
            {
              binding: 1,
              resource: history[1 - i].createView({
                label: `taa:history-view-${i}`,
              }),
            },
            {
              binding: 2,
              resource: t.velocity.createView({label: 'taa:velocity-view'}),
            },
            {
              binding: 3,
              resource: t.depth.createView({label: 'taa:depth-view'}),
            },
            {binding: 4, resource: sampler},
            {binding: 5, resource: {buffer: resetBuf}},
          ],
        }),
      );
      needsReset = true;
    },
    run(ctx: FrameContext) {
      current = 1 - current;
      device.queue.writeBuffer(
        resetBuf,
        0,
        new Float32Array([needsReset ? 1 : 0]),
      );
      needsReset = false;
      const pass = ctx.encoder.beginRenderPass({
        label: 'taa:pass',
        colorAttachments: [
          {view: history[current], loadOp: 'clear', storeOp: 'store'},
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, groups[current]);
      pass.draw(3);
      pass.end();
      return history[current];
    },
  };
}

/** Halton low-discrepancy sequence, for sub-pixel jitter. */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}
