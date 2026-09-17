// Physically based bloom: a mip chain of 13-tap downsamples and tent-filter
// upsamples (as in Call of Duty: Advanced Warfare). The result is blended into
// the scene in the present pass.

import {createShader} from '../../gpu/device.ts';
import {fullscreenVS} from '../../shaders/index.ts';
import {HDR_FORMAT, type FrameContext, type Targets} from '../renderer.ts';

const shader = /* wgsl */ `
${fullscreenVS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

fn karisWeight(c: vec3f) -> f32 {
  return 1.0 / (1.0 + dot(c, vec3f(0.2126, 0.7152, 0.0722)) * 0.25);
}

@fragment
fn down(i: FSOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let uv = i.uv;
  let a = textureSampleLevel(src, samp, uv + t * vec2f(-2.0, -2.0), 0.0).rgb;
  let b = textureSampleLevel(src, samp, uv + t * vec2f(0.0, -2.0), 0.0).rgb;
  let c = textureSampleLevel(src, samp, uv + t * vec2f(2.0, -2.0), 0.0).rgb;
  let d = textureSampleLevel(src, samp, uv + t * vec2f(-2.0, 0.0), 0.0).rgb;
  let e = textureSampleLevel(src, samp, uv, 0.0).rgb;
  let f = textureSampleLevel(src, samp, uv + t * vec2f(2.0, 0.0), 0.0).rgb;
  let g = textureSampleLevel(src, samp, uv + t * vec2f(-2.0, 2.0), 0.0).rgb;
  let h = textureSampleLevel(src, samp, uv + t * vec2f(0.0, 2.0), 0.0).rgb;
  let k = textureSampleLevel(src, samp, uv + t * vec2f(2.0, 2.0), 0.0).rgb;
  let j = textureSampleLevel(src, samp, uv + t * vec2f(-1.0, -1.0), 0.0).rgb;
  let l = textureSampleLevel(src, samp, uv + t * vec2f(1.0, -1.0), 0.0).rgb;
  let m = textureSampleLevel(src, samp, uv + t * vec2f(-1.0, 1.0), 0.0).rgb;
  let n = textureSampleLevel(src, samp, uv + t * vec2f(1.0, 1.0), 0.0).rgb;
  // Karis average on the groups reduces fireflies from the sun disk.
  let g0 = (j + l + m + n) * 0.25;
  let g1 = (a + b + d + e) * 0.25;
  let g2 = (b + c + e + f) * 0.25;
  let g3 = (d + e + g + h) * 0.25;
  let g4 = (e + f + h + k) * 0.25;
  let w0 = karisWeight(g0) * 0.5;
  let w1 = karisWeight(g1) * 0.125;
  let w2 = karisWeight(g2) * 0.125;
  let w3 = karisWeight(g3) * 0.125;
  let w4 = karisWeight(g4) * 0.125;
  let col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  // A net against non-finite pixels. Bloom is where one bad pixel stops being
  // one bad pixel: it is averaged into a mip and then scaled back up, so a
  // single NaN anywhere in the frame comes back as a block. Whether that block
  // ends up black is then up to how the implementation treats NaN in min, max
  // and clamp, which the specification leaves open — so this is exactly the
  // kind of fault that shows on one browser and not another. Cheap to refuse
  // it here, where the whole frame passes through.
  let safe = select(vec3f(0.0), col, col == col);
  return vec4f(min(safe, vec3f(64.0)), 1.0);
}

@fragment
fn up(i: FSOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let uv = i.uv;
  var c = textureSampleLevel(src, samp, uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(src, samp, uv + vec2f(-t.x, 0.0), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, uv + vec2f(t.x, 0.0), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, uv + vec2f(0.0, -t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, uv + vec2f(0.0, t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, uv + vec2f(-t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(-t.x, t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(t.x, t.y), 0.0).rgb;
  return vec4f(c / 16.0, 1.0);
}
`;

export class Bloom {
  private device: GPUDevice;
  private downPipeline!: GPURenderPipeline;
  private upPipeline!: GPURenderPipeline;
  private sampler: GPUSampler;
  private levels: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private downGroups: GPUBindGroup[] = [];
  private upGroups: GPUBindGroup[] = [];
  private input: GPUTexture | null = null;
  private levelCount: number;
  private maxLevels: number;

  constructor(device: GPUDevice, maxLevels = 6) {
    this.device = device;
    this.maxLevels = maxLevels;
    this.levelCount = maxLevels;
    this.sampler = device.createSampler({
      label: 'bloom:sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  async init() {
    const module = createShader(this.device, 'bloom:shader', shader);
    const layout = this.device.createBindGroupLayout({
      label: 'bloom:bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {sampleType: 'float'},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: {type: 'filtering'},
        },
      ],
    });
    const pipelineLayout = this.device.createPipelineLayout({
      label: 'bloom:pipeline-layout',
      bindGroupLayouts: [layout],
    });
    [this.downPipeline, this.upPipeline] = await Promise.all([
      this.device.createRenderPipelineAsync({
        label: 'bloom:down-pipeline',
        layout: pipelineLayout,
        vertex: {module, entryPoint: 'vsFullscreen'},
        fragment: {module, entryPoint: 'down', targets: [{format: HDR_FORMAT}]},
      }),
      this.device.createRenderPipelineAsync({
        label: 'bloom:up-pipeline',
        layout: pipelineLayout,
        vertex: {module, entryPoint: 'vsFullscreen'},
        fragment: {
          module,
          entryPoint: 'up',
          targets: [
            {
              format: HDR_FORMAT,
              blend: {
                color: {srcFactor: 'one', dstFactor: 'one', operation: 'add'},
                alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'},
              },
            },
          ],
        },
      }),
    ]);
  }

  /** The upsampled bloom result (half resolution). */
  get result(): GPUTexture {
    return this.levels[0];
  }

  resize(t: Targets) {
    // How far the chain is worth taking depends on the frame's size, not on a
    // fixed number. Each level is two render passes, and on a tiled GPU a pass
    // costs about as much for a handful of pixels as for a screenful: on a
    // phone the sixth level is some 6x13 pixels and still costs a full pass.
    // Stop once a level stops being a meaningful fraction of the screen.
    this.levelCount = Math.max(
      3,
      Math.min(
        this.maxLevels,
        Math.floor(Math.log2(Math.min(t.width, t.height))) - 4,
      ),
    );
    this.levels.forEach(l => l.destroy());
    this.levels = [];
    this.views = [];
    let w = t.width;
    let h = t.height;
    for (let i = 0; i < this.levelCount; i++) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      const tex = this.device.createTexture({
        label: `bloom:level-${i}`,
        size: [w, h],
        format: HDR_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.levels.push(tex);
      this.views.push(tex.createView({label: `bloom:level-view-${i}`}));
    }
    this.input = null;
  }

  run(ctx: FrameContext, input: GPUTexture) {
    const d = this.device;
    if (this.input !== input) {
      this.input = input;
      const layout = this.downPipeline.getBindGroupLayout(0);
      this.downGroups = this.levels.map((_, i) =>
        d.createBindGroup({
          label: `bloom:down-bind-group-${i}`,
          layout,
          entries: [
            {
              binding: 0,
              resource:
                i === 0
                  ? input.createView({label: 'bloom:input-view'})
                  : this.views[i - 1],
            },
            {binding: 1, resource: this.sampler},
          ],
        }),
      );
      this.upGroups = this.levels.map((_, i) =>
        d.createBindGroup({
          label: `bloom:up-bind-group-${i}`,
          layout: this.upPipeline.getBindGroupLayout(0),
          entries: [
            {binding: 0, resource: this.views[i]},
            {binding: 1, resource: this.sampler},
          ],
        }),
      );
    }
    for (let i = 0; i < this.levels.length; i++) {
      const pass = ctx.encoder.beginRenderPass({
        label: `bloom:down-pass-${i}`,
        colorAttachments: [
          {view: this.views[i], loadOp: 'clear', storeOp: 'store'},
        ],
      });
      pass.setPipeline(this.downPipeline);
      pass.setBindGroup(0, this.downGroups[i]);
      pass.draw(3);
      pass.end();
    }
    for (let i = this.levels.length - 1; i > 0; i--) {
      const pass = ctx.encoder.beginRenderPass({
        label: `bloom:up-pass-${i}`,
        colorAttachments: [
          {view: this.views[i - 1], loadOp: 'load', storeOp: 'store'},
        ],
      });
      pass.setPipeline(this.upPipeline);
      pass.setBindGroup(0, this.upGroups[i]);
      pass.draw(3);
      pass.end();
    }
  }
}
