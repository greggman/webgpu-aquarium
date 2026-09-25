// Auto-focus from the real depth buffer: every few frames a grid of points
// across the middle of the screen is rendered into a small float texture
// (depth textures must be copied whole) and read back asynchronously. Each
// point carries its distance and whether a fish drew it (from the ID target),
// so focus goes to the fish in the shot, as a photographer's would, rather
// than to whatever reef happens to sit under the crosshair.

import {createShader} from '../gpu/device.ts';
import {fullscreenVS} from '../shaders/index.ts';
import {idWgsl} from './ids.ts';

const W = 64;
const H = 48;
const NEAR = 0.05;
/** Share of the screen (centred) the grid covers. */
const SPAN = 0.6;
/** Share of the grid that must be fish before focus goes to them. */
const FISH_SHARE = 0.015;

const shader = /* wgsl */ `
${idWgsl}
${fullscreenVS}
@group(0) @binding(0) var tDepth: texture_depth_2d;
@group(0) @binding(1) var tId: texture_2d<u32>;

@fragment
fn fs(i: FSOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(tDepth));
  let at = (0.5 - ${SPAN / 2}) + ${SPAN} * (i.pos.xy / vec2f(${W}.0, ${H}.0));
  let p = clamp(vec2i(at * size), vec2i(0), vec2i(size) - 1);
  let d = textureLoad(tDepth, p, 0);
  let dist = select(60.0, ${NEAR} / max(d, 1e-6), d > 0.0);
  let fish = select(0.0, 1.0, idCategory(textureLoad(tId, p, 0).r) == CAT_FISH);
  return vec4f(dist, fish, 0.0, 1.0);
}
`;

export class AutoFocus {
  /** Latest measured focus distance in metres (null until the first read). */
  measured: number | null = null;
  private device: GPUDevice;
  private target: GPUTexture;
  private buffer: GPUBuffer;
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup | null = null;
  private boundDepth: GPUTexture | null = null;
  private pending = false;
  private frame = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.target = device.createTexture({
      label: 'autofocus:target',
      size: [W, H],
      format: 'rg32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.buffer = device.createBuffer({
      label: 'autofocus:readback',
      size: W * 8 * H,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const module = createShader(device, 'autofocus:shader', shader);
    this.pipeline = device.createRenderPipeline({
      label: 'autofocus:pipeline',
      layout: 'auto',
      vertex: {module, entryPoint: 'vsFullscreen'},
      fragment: {module, entryPoint: 'fs', targets: [{format: 'rg32float'}]},
    });
  }

  /** Queues a measurement into `encoder` every few frames. Returns true if queued. */
  sample(
    encoder: GPUCommandEncoder,
    depth: GPUTexture,
    id: GPUTexture,
  ): boolean {
    if (this.pending || this.frame++ % 6 !== 0) {
      return false;
    }
    // Depth and ID are recreated together on resize.
    if (this.boundDepth !== depth) {
      this.boundDepth = depth;
      this.bindGroup = this.device.createBindGroup({
        label: 'autofocus:bind-group',
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: depth.createView({label: 'autofocus:depth-view'}),
          },
          {binding: 1, resource: id.createView({label: 'autofocus:id-view'})},
        ],
      });
    }
    this.pending = true;
    const pass = encoder.beginRenderPass({
      label: 'autofocus:pass',
      colorAttachments: [
        {view: this.target, loadOp: 'clear', storeOp: 'store'},
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup!);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      {texture: this.target},
      {buffer: this.buffer, bytesPerRow: W * 8},
      [W, H],
    );
    return true;
  }

  /** Call after the encoder that sampled has been submitted. */
  read() {
    void this.buffer.mapAsync(GPUMapMode.READ).then(() => {
      const values = new Float32Array(this.buffer.getMappedRange().slice(0));
      this.buffer.unmap();
      const fish: number[] = [];
      const centre: number[] = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const dist = values[(y * W + x) * 2];
          // Something about to pass the lens is not what is being shot.
          if (values[(y * W + x) * 2 + 1] > 0.5 && dist > 0.3) {
            fish.push(dist);
          }
          // Without fish, fall back to the middle third, as before.
          if (Math.abs(x - W / 2) < W / 6 && Math.abs(y - H / 2) < H / 6) {
            centre.push(dist);
          }
        }
      }
      // Fish in the shot take the focus; otherwise what is in the middle.
      // Either way favour nearer things, as a photographer would.
      const pick = fish.length >= W * H * FISH_SHARE ? fish : centre;
      pick.sort((a, b) => a - b);
      this.measured = Math.min(
        60,
        pick[Math.floor(pick.length * (pick === fish ? 0.25 : 0.2))],
      );
      this.pending = false;
    });
  }
}
