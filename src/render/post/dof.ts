// Depth of field: a half-resolution scatter-as-gather blur driven by the
// circle of confusion from the depth buffer, composited back over the sharp
// image. Kept gentle: underwater, distance is already softened by the water,
// so DOF mostly rounds off very near foreground and the far background.

import {createShader} from '../../gpu/device.ts';
import {fullscreenVS} from '../../shaders/index.ts';
import {
  HDR_FORMAT,
  type FrameContext,
  type PostEffect,
  type Targets,
} from '../renderer.ts';

const NEAR = 0.05;

const shader = /* wgsl */ `
${fullscreenVS}
struct Dof {
  focus: f32,
  aperture: f32,
  maxCoc: f32,
  pad: f32,
};
@group(0) @binding(0) var tColor: texture_2d<f32>;
@group(0) @binding(1) var tDepth: texture_depth_2d;
@group(0) @binding(2) var tHalf: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> dof: Dof;

fn cocAt(p: vec2i) -> f32 {
  let d = textureLoad(tDepth, p, 0);
  let z = select(1000.0, ${NEAR} / max(d, 1e-7), d > 0.0);
  // Thin-lens circle of confusion ~ aperture * (1/focus - 1/z): depth of field
  // is deep when focused far and shallow when focused close, like a real lens.
  // Signed: negative in front of the focus plane, positive behind. Background
  // blur is capped lower than foreground: distant water is soft already.
  return clamp((1.0 / dof.focus - 1.0 / z) * dof.aperture, -dof.maxCoc, dof.maxCoc * 0.3);
}

// Downsample to half resolution, storing colour and CoC (in pixels at half res).
@fragment
fn prefilter(i: FSOut) -> @location(0) vec4f {
  let full = vec2i(i.pos.xy * 2.0);
  let c = textureSampleLevel(tColor, samp, i.uv, 0.0).rgb;
  var coc = cocAt(full);
  // Take the most-in-front CoC of the 2x2 footprint so foreground edges blur outward.
  coc = min(coc, cocAt(full + vec2i(1, 0)));
  coc = min(coc, cocAt(full + vec2i(0, 1)));
  coc = min(coc, cocAt(full + vec2i(1, 1)));
  return vec4f(c, coc);
}

@fragment
fn blur(i: FSOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(tHalf));
  let center = textureSampleLevel(tHalf, samp, i.uv, 0.0);
  let radius = abs(center.a);
  if (radius < 0.5) {
    return center;
  }
  var sum = vec3f(0.0);
  var wsum = 0.0;
  let count = 24;
  for (var k = 0; k < count; k++) {
    let fk = f32(k);
    let r = sqrt((fk + 0.5) / f32(count)) * radius;
    let a = fk * 2.39996;
    let uv = i.uv + vec2f(cos(a), sin(a)) * r / size;
    let s = textureSampleLevel(tHalf, samp, uv, 0.0);
    // A sample contributes if its own blur reaches this pixel; foreground
    // (negative CoC) always may, so near objects bleed over the background.
    let reach = select(abs(s.a), max(abs(s.a), radius), s.a >= center.a);
    let w = smoothstep(r - 1.0, r + 0.5, reach);
    sum += s.rgb * w;
    wsum += w;
  }
  return vec4f(sum / max(wsum, 1e-4), center.a);
}

@fragment
fn composite(i: FSOut) -> @location(0) vec4f {
  let sharp = textureLoad(tColor, vec2i(i.pos.xy), 0).rgb;
  let blurred = textureSampleLevel(tHalf, samp, i.uv, 0.0);
  let coc = abs(cocAt(vec2i(i.pos.xy))) * 0.5 + abs(blurred.a) * 0.5;
  let t = smoothstep(0.5, 2.0, coc);
  return vec4f(mix(sharp, blurred.rgb, t), 1.0);
}
`;

export async function createDof(
  device: GPUDevice,
): Promise<PostEffect & {setFocus(d: number): void}> {
  const module = createShader(device, 'dof:shader', shader);
  const bgl = device.createBindGroupLayout({
    label: 'dof:bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {sampleType: 'float'},
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {sampleType: 'depth'},
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {sampleType: 'float'},
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: {type: 'filtering'},
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {type: 'uniform'},
      },
    ],
  });
  const layout = device.createPipelineLayout({
    label: 'dof:pipeline-layout',
    bindGroupLayouts: [bgl],
  });
  const make = (entryPoint: string) =>
    device.createRenderPipelineAsync({
      label: `dof:${entryPoint}-pipeline`,
      layout,
      vertex: {module, entryPoint: 'vsFullscreen'},
      fragment: {module, entryPoint, targets: [{format: HDR_FORMAT}]},
    });
  const [prefilter, blur, composite] = await Promise.all([
    make('prefilter'),
    make('blur'),
    make('composite'),
  ]);
  const sampler = device.createSampler({
    label: 'dof:sampler',
    magFilter: 'linear',
    minFilter: 'linear',
  });
  const uniform = device.createBuffer({
    label: 'dof:uniform',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const dummy = device.createTexture({
    label: 'dof:dummy',
    size: [1, 1],
    format: HDR_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });

  let half: GPUTexture[] = [];
  let output: GPUTexture | null = null;
  let targets: Targets | null = null;
  let focus = 6;
  const groups = new Map<string, GPUBindGroup>();
  const group = (key: string, color: GPUTexture, halfTex: GPUTexture) => {
    let g = groups.get(key);
    if (!g && targets) {
      g = device.createBindGroup({
        label: `dof:bind-group-${key}`,
        layout: bgl,
        entries: [
          {
            binding: 0,
            resource: color.createView({label: `dof:color-view-${key}`}),
          },
          {
            binding: 1,
            resource: targets.depth.createView({
              label: `dof:depth-view-${key}`,
            }),
          },
          {
            binding: 2,
            resource: halfTex.createView({label: `dof:half-view-${key}`}),
          },
          {binding: 3, resource: sampler},
          {binding: 4, resource: {buffer: uniform}},
        ],
      });
      groups.set(key, g);
    }
    return g!;
  };
  const passTo = (
    ctx: FrameContext,
    label: string,
    view: GPUTexture,
    pipeline: GPURenderPipeline,
    bg: GPUBindGroup,
  ) => {
    const pass = ctx.encoder.beginRenderPass({
      label: `dof:${label}-pass`,
      colorAttachments: [{view, loadOp: 'clear', storeOp: 'store'}],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  };

  return {
    name: 'dof',
    setFocus(d: number) {
      focus = d;
    },
    resize(t: Targets) {
      targets = t;
      half.forEach(h => h.destroy());
      output?.destroy();
      groups.clear();
      const hw = Math.max(1, Math.ceil(t.width / 2));
      const hh = Math.max(1, Math.ceil(t.height / 2));
      half = [0, 1].map(i =>
        device.createTexture({
          label: `dof:half-${i}`,
          size: [hw, hh],
          format: HDR_FORMAT,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
      output = device.createTexture({
        label: 'dof:output',
        size: [t.width, t.height],
        format: HDR_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    },
    run(ctx: FrameContext, input: GPUTexture) {
      if (!targets || !output) {
        return input;
      }
      // Aperture scales with resolution so the look is resolution independent.
      const aperture = (targets.height / 1080) * 9;
      device.queue.writeBuffer(
        uniform,
        0,
        new Float32Array([focus, aperture, 6, 0]),
      );
      // The input alternates between TAA history textures; cache per texture.
      passTo(
        ctx,
        'prefilter',
        half[0],
        prefilter,
        group(`pre-${input.label}`, input, dummy),
      );
      passTo(ctx, 'blur', half[1], blur, group('blur', dummy, half[0]));
      passTo(
        ctx,
        'composite',
        output,
        composite,
        group(`comp-${input.label}`, input, half[1]),
      );
      return output;
    },
  };
}
