// Final pass: exposure, AgX tone mapping, grade, vignette, grain, sRGB encode.

import {createShader} from '../../gpu/device.ts';
import {fullscreenVS, globals, noise} from '../../shaders/index.ts';
import type {FrameContext} from '../renderer.ts';

const shader = /* wgsl */ `
${globals}
${noise}
${fullscreenVS}

struct Grade {
  lift: vec3f,
  saturation: f32,
  gamma: vec3f,
  contrast: f32,
  gain: vec3f,
  vignette: f32,
  grain: f32,
  renderScale: f32,
  bloomStrength: f32,
  /** Sharpening after upscaling (0 at native resolution). */
  sharpen: f32,
};
@group(1) @binding(0) var tScene: texture_2d<f32>;
@group(1) @binding(1) var<uniform> grade: Grade;
@group(1) @binding(2) var tBloom: texture_2d<f32>;

// AgX (Troy Sobotka), fitted by Benjamin Wrensch.
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn agx(v: vec3f) -> vec3f {
  let m = mat3x3f(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104,
  );
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var c = m * max(v, vec3f(1e-10));
  c = clamp(log2(c), vec3f(minEv), vec3f(maxEv));
  c = (c - minEv) / (maxEv - minEv);
  return agxContrast(c);
}

fn agxEotf(v: vec3f) -> vec3f {
  let mi = mat3x3f(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116,
  );
  return pow(max(mi * v, vec3f(0.0)), vec3f(2.2));
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

// Compress HDR for filtering so a few very bright pixels don't ring.
fn tmw(c: vec3f) -> vec3f {
  return c / (1.0 + max(max(c.r, c.g), c.b));
}
fn itmw(c: vec3f) -> vec3f {
  return c / max(1.0 - max(max(c.r, c.g), c.b), 1e-4);
}

/**
 * Upscale from the (smaller) render resolution: 5-tap Catmull-Rom (sharper
 * than bilinear), then contrast-adaptive sharpening that restores edge detail
 * without halos (the result stays within the local min/max).
 */
fn upscale(uv: vec2f, size: vec2f) -> vec3f {
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
  c += tmw(textureSampleLevel(tScene, sLinearClamp, vec2f(tc12.x, tc0.y), 0.0).rgb) * (w12.x * w0.y);
  c += tmw(textureSampleLevel(tScene, sLinearClamp, vec2f(tc0.x, tc12.y), 0.0).rgb) * (w0.x * w12.y);
  c += tmw(textureSampleLevel(tScene, sLinearClamp, vec2f(tc12.x, tc12.y), 0.0).rgb) * (w12.x * w12.y);
  c += tmw(textureSampleLevel(tScene, sLinearClamp, vec2f(tc3.x, tc12.y), 0.0).rgb) * (w3.x * w12.y);
  c += tmw(textureSampleLevel(tScene, sLinearClamp, vec2f(tc12.x, tc3.y), 0.0).rgb) * (w12.x * w3.y);
  let wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  c /= wsum;

  // Contrast-adaptive sharpening on the source-pixel cross around the sample.
  let px = vec2i(clamp(pos, vec2f(0.0), size - 1.0));
  let maxP = vec2i(size) - 1;
  let n = tmw(textureLoad(tScene, clamp(px + vec2i(0, -1), vec2i(0), maxP), 0).rgb);
  let sx = tmw(textureLoad(tScene, clamp(px + vec2i(0, 1), vec2i(0), maxP), 0).rgb);
  let e = tmw(textureLoad(tScene, clamp(px + vec2i(1, 0), vec2i(0), maxP), 0).rgb);
  let wv = tmw(textureLoad(tScene, clamp(px + vec2i(-1, 0), vec2i(0), maxP), 0).rgb);
  let mid = tmw(textureLoad(tScene, px, 0).rgb);
  let mn = min(mid, min(min(n, sx), min(e, wv)));
  let mx = max(mid, max(max(n, sx), max(e, wv)));
  // Less sharpening where local contrast is already high.
  let amount = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3f(1e-4)), vec3f(0.0), vec3f(1.0)));
  let k = amount * grade.sharpen;
  let blur = (n + sx + e + wv) * 0.25;
  c = clamp(c + (c - blur) * k, mn, mx);
  return itmw(max(c, vec3f(0.0)));
}

@fragment
fn fs(i: FSOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(tScene));
  var hdr = upscale(i.uv, size);
  let bloom = textureSampleLevel(tBloom, sLinearClamp, i.uv, 0.0).rgb;
  hdr = mix(hdr, bloom, grade.bloomStrength);
  hdr *= frame.exposure;

  // Vignette in HDR so it rolls off naturally.
  let d = (i.uv - 0.5) * vec2f(size.x / size.y, 1.0);
  hdr *= mix(1.0, smoothstep(1.25, 0.15, length(d)), grade.vignette);

  // AgX base, then a gentle look.
  var c = agxEotf(agx(hdr));
  // Lift / gamma / gain
  c = max(c * grade.gain + grade.lift * (1.0 - c), vec3f(0.0));
  c = pow(c, 1.0 / grade.gamma);
  let l = luma(c);
  c = mix(vec3f(l), c, grade.saturation);
  c = 0.18 * pow(c / 0.18, vec3f(grade.contrast));
  c = clamp(c, vec3f(0.0), vec3f(1.0));

  var srgb = linearToSrgb(c);
  // Film grain + dither to kill banding in the smooth water gradients.
  let n = ign(i.pos.xy, frame.frameIndex) + ign(i.pos.yx + 17.0, frame.frameIndex + 7u) - 1.0;
  srgb += n * (grade.grain * 0.035 + 1.0 / 255.0);
  return vec4f(srgb, 1.0);
}
`;

export interface GradeSettings {
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  saturation: number;
  contrast: number;
  vignette: number;
  grain: number;
  bloom: number;
}

export async function createPresent(
  device: GPUDevice,
  globalsLayout: GPUBindGroupLayout,
  canvasFormat: GPUTextureFormat,
) {
  const module = createShader(device, 'present:shader', shader);
  const localLayout = device.createBindGroupLayout({
    label: 'present:local-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {sampleType: 'float'},
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {type: 'uniform', minBindingSize: 64},
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {sampleType: 'float'},
      },
    ],
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'present:pipeline',
    layout: device.createPipelineLayout({
      label: 'present:pipeline-layout',
      bindGroupLayouts: [globalsLayout, localLayout],
    }),
    vertex: {module, entryPoint: 'vsFullscreen'},
    fragment: {module, entryPoint: 'fs', targets: [{format: canvasFormat}]},
  });
  const gradeBuf = device.createBuffer({
    label: 'present:grade-uniform',
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  let bindGroup: GPUBindGroup | null = null;
  let boundTexture: GPUTexture | null = null;
  let boundBloom: GPUTexture | null = null;
  let lastSharpen = -1;

  return {
    setGrade(g: GradeSettings) {
      const f = new Float32Array(16);
      f.set(g.lift, 0);
      f[3] = g.saturation;
      f.set(g.gamma, 4);
      f[7] = g.contrast;
      f.set(g.gain, 8);
      f[11] = g.vignette;
      f[12] = g.grain;
      f[14] = g.bloom;
      f[15] = Math.max(lastSharpen, 0);
      device.queue.writeBuffer(gradeBuf, 0, f);
    },
    run(
      ctx: FrameContext,
      input: GPUTexture,
      bloom: GPUTexture,
      view: GPUTexture,
    ) {
      // Sharpen in proportion to how much the image is being upscaled.
      const scale = input.width / view.width;
      const sharpen = Math.min(0.9, Math.max(0, (1 - scale) * 2.5));
      if (sharpen !== lastSharpen) {
        lastSharpen = sharpen;
        device.queue.writeBuffer(gradeBuf, 60, new Float32Array([sharpen]));
      }
      if (boundTexture !== input || boundBloom !== bloom) {
        boundTexture = input;
        boundBloom = bloom;
        bindGroup = device.createBindGroup({
          label: 'present:local-bind-group',
          layout: localLayout,
          entries: [
            {
              binding: 0,
              resource: input.createView({label: 'present:scene-view'}),
            },
            {binding: 1, resource: {buffer: gradeBuf}},
            {
              binding: 2,
              resource: bloom.createView({label: 'present:bloom-view'}),
            },
          ],
        });
      }
      const pass = ctx.encoder.beginRenderPass({
        label: 'present:pass',
        colorAttachments: [{view, loadOp: 'clear', storeOp: 'store'}],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, ctx.globals);
      pass.setBindGroup(1, bindGroup!);
      pass.draw(3);
      pass.end();
    },
  };
}
