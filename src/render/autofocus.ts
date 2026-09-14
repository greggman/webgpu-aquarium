// Auto-focus from the real depth buffer: every few frames a small region at
// the centre of the screen is rendered into a float texture (depth textures
// must be copied whole) and read back asynchronously, so focus follows
// whatever is actually under the crosshair (kelp, coral, fish).

import {createShader} from '../gpu/device.ts';
import {fullscreenVS} from '../shaders/index.ts';

const W = 64;
const H = 16;
const NEAR = 0.05;

const shader = /* wgsl */ `
${fullscreenVS}
@group(0) @binding(0) var tDepth: texture_depth_2d;

@fragment
fn fs(i: FSOut) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(tDepth));
  let p = size / 2 - vec2i(${W / 2}, ${H / 2}) + vec2i(i.pos.xy);
  let d = textureLoad(tDepth, clamp(p, vec2i(0), size - 1), 0);
  let dist = select(60.0, ${NEAR} / max(d, 1e-6), d > 0.0);
  return vec4f(dist, 0.0, 0.0, 1.0);
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
      format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.buffer = device.createBuffer({
      label: 'autofocus:readback',
      size: 256 * (H - 1) + W * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const module = createShader(device, 'autofocus:shader', shader);
    this.pipeline = device.createRenderPipeline({
      label: 'autofocus:pipeline',
      layout: 'auto',
      vertex: {module, entryPoint: 'vsFullscreen'},
      fragment: {module, entryPoint: 'fs', targets: [{format: 'r32float'}]},
    });
  }

  /** Queues a measurement into `encoder` every few frames. Returns true if queued. */
  sample(encoder: GPUCommandEncoder, depth: GPUTexture): boolean {
    if (this.pending || this.frame++ % 6 !== 0) {
      return false;
    }
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
      {buffer: this.buffer, bytesPerRow: 256},
      [W, H],
    );
    return true;
  }

  /** Call after the encoder that sampled has been submitted. */
  read() {
    void this.buffer.mapAsync(GPUMapMode.READ).then(() => {
      const values = new Float32Array(this.buffer.getMappedRange().slice(0));
      this.buffer.unmap();
      const distances: number[] = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x += 2) {
          distances.push(values[(y * 256) / 4 + x]);
        }
      }
      distances.sort((a, b) => a - b);
      // Favour nearer things in the region, as a photographer would.
      this.measured = Math.min(
        60,
        distances[Math.floor(distances.length * 0.3)],
      );
      this.pending = false;
    });
  }
}
