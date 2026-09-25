// Frame orchestration: render targets, pass ordering, and the systems that
// draw into each pass.

import type {Gpu} from '../gpu/device.ts';
import {ID_FORMAT} from './ids.ts';
import type {Quality} from '../core/quality.ts';
import {
  createGlobals,
  createGlobalsBindGroup,
  type Globals,
  type GlobalTextures,
} from './globals.ts';
import {createSolidTexture} from '../gpu/util.ts';
import type {Footprint} from './contact.ts';

export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
export const VELOCITY_FORMAT: GPUTextureFormat = 'rg16float';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

export interface Targets {
  width: number;
  height: number;
  color: GPUTexture;
  velocity: GPUTexture;
  /** What drew each pixel (see render/ids.ts). */
  id: GPUTexture;
  depth: GPUTexture;
}

export interface FrameContext {
  encoder: GPUCommandEncoder;
  globals: GPUBindGroup;
  targets: Targets;
  time: number;
  dt: number;
  view: CullView;
}

/** What systems need for CPU-side visibility culling. */
export interface CullView {
  camPos: Float32Array;
  /** Unjittered camera view-projection. */
  viewProj: Float32Array;
  shadowViewProj: Float32Array;
  /** Beyond this the water hides everything. */
  maxDistance: number;
  /** Pixels covered by one world unit at distance 1 (for screen-size LOD). */
  focalPx: number;
}

/** Anything that renders. All hooks are optional. */
export interface RenderSystem {
  name: string;
  /** Compute work or buffer updates before any pass. */
  update?(ctx: FrameContext): void;
  drawShadow?(pass: GPURenderPassEncoder): void;
  drawOpaque?(pass: GPURenderPassEncoder): void;
  /** Runs its own passes after opaque geometry (e.g. volumetrics reading depth). */
  afterOpaque?(ctx: FrameContext): void;
  /** Blended geometry after the opaque pass (depth read-only). */
  drawTransparent?(pass: GPURenderPassEncoder): void;
  /** Called when render targets are recreated. */
  resize?(targets: Targets): void;
}

/** A full-screen pass that reads the scene and writes the next image. */
export interface PostEffect {
  name: string;
  /** Returns the texture holding the result (may be `input` if disabled). */
  run(ctx: FrameContext, input: GPUTexture): GPUTexture;
  resize?(targets: Targets): void;
}

export class Renderer {
  readonly gpu: Gpu;
  readonly device: GPUDevice;
  readonly quality: Quality;
  readonly globals: Globals;
  targets!: Targets;
  textures: GlobalTextures;
  globalsBindGroup!: GPUBindGroup;
  /** Same as globals but with a dummy shadow map, for use while rendering the shadow map. */
  shadowGlobalsBindGroup!: GPUBindGroup;
  systems: RenderSystem[] = [];
  post: PostEffect[] = [];
  /** Final pass that writes to the canvas. */
  present:
    ((ctx: FrameContext, input: GPUTexture, view: GPUTexture) => void) | null =
    null;
  shadowMap: GPUTexture | null = null;
  /** Where props meet the ground, collected while content is generated. */
  readonly footprints: Footprint[] = [];
  private dummyShadow: GPUTexture;

  constructor(gpu: Gpu, quality: Quality) {
    this.gpu = gpu;
    this.device = gpu.device;
    this.quality = quality;
    this.globals = createGlobals(this.device);
    const d = this.device;
    this.dummyShadow = d.createTexture({
      label: 'renderer:dummy-shadow',
      size: [1, 1],
      format: DEPTH_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // Cleared to the far plane, so sampling it with the shadow comparison
    // reads as fully lit everywhere. It stands in for the real map both while
    // that map is being drawn and when the viewer has turned shadows off; left
    // at its zero fill it would instead read as shadowed everywhere.
    const clear = d.createCommandEncoder({
      label: 'renderer:clear-dummy-shadow',
    });
    clear
      .beginRenderPass({
        label: 'renderer:clear-dummy-shadow-pass',
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.dummyShadow.createView({
            label: 'renderer:dummy-shadow-view',
          }),
          depthLoadOp: 'clear',
          depthClearValue: 1,
          depthStoreOp: 'store',
        },
      })
      .end();
    d.queue.submit([
      clear.finish({label: 'renderer:clear-dummy-shadow-commands'}),
    ]);
    this.textures = {
      shadow: this.dummyShadow,
      caustics: createSolidTexture(
        d,
        'renderer:placeholder-caustics',
        'rgba16float',
        [1, 1, 1, 1],
      ),
      detail: createSolidTexture(
        d,
        'renderer:placeholder-detail',
        'rgba16float',
        [0.5, 0.5, 0.5, 0.5],
      ),
      terrain: createSolidTexture(
        d,
        'renderer:placeholder-terrain',
        'rgba16float',
        [-20, 0, 0, 1],
      ),
      terrainMask: createSolidTexture(
        d,
        'renderer:placeholder-terrain-mask',
        'rgba8unorm',
        [0, 0, 0, 0],
      ),
      contact: createSolidTexture(
        d,
        'renderer:placeholder-contact',
        'rgba8unorm',
        [1, 1, 1, 1],
      ),
    };
    this.rebuildGlobals();
  }

  /**
   * Turns the sun's shadows on or off: `null` skips the pass that draws the
   * map and points the lighting at one that reads as fully lit.
   */
  setShadows(map: GPUTexture | null) {
    this.shadowMap = map;
    this.setTextures({shadow: map ?? this.dummyShadow});
  }

  setTextures(t: Partial<GlobalTextures>) {
    Object.assign(this.textures, t);
    this.rebuildGlobals();
  }

  private rebuildGlobals() {
    this.globalsBindGroup = createGlobalsBindGroup(
      this.device,
      this.globals,
      this.textures,
    );
    this.shadowGlobalsBindGroup = createGlobalsBindGroup(
      this.device,
      this.globals,
      {
        ...this.textures,
        shadow: this.dummyShadow,
      },
    );
  }

  resize(width: number, height: number) {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (
      this.targets &&
      this.targets.width === width &&
      this.targets.height === height
    ) {
      return;
    }
    this.targets?.color.destroy();
    this.targets?.velocity.destroy();
    this.targets?.id.destroy();
    this.targets?.depth.destroy();
    const d = this.device;
    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.targets = {
      width,
      height,
      color: d.createTexture({
        label: 'targets:hdr-color',
        size: [width, height],
        format: HDR_FORMAT,
        usage: usage | GPUTextureUsage.COPY_SRC,
      }),
      velocity: d.createTexture({
        label: 'targets:velocity',
        size: [width, height],
        format: VELOCITY_FORMAT,
        usage,
      }),
      id: d.createTexture({
        label: 'targets:id',
        size: [width, height],
        format: ID_FORMAT,
        usage,
      }),
      depth: d.createTexture({
        label: 'targets:depth',
        size: [width, height],
        format: DEPTH_FORMAT,
        usage,
      }),
    };
    for (const s of this.systems) {
      s.resize?.(this.targets);
    }
    for (const p of this.post) {
      p.resize?.(this.targets);
    }
  }

  /** Updated by the frame loop before render(). */
  readonly cullView: CullView = {
    camPos: new Float32Array(3),
    viewProj: new Float32Array(16),
    shadowViewProj: new Float32Array(16),
    maxDistance: 80,
    focalPx: 1000,
  };

  render(time: number, dt: number) {
    const d = this.device;
    const g = this.globals;
    d.queue.writeBuffer(g.buffer, 0, g.data.data);

    const encoder = d.createCommandEncoder({label: 'frame:encoder'});
    const ctx: FrameContext = {
      encoder,
      globals: this.globalsBindGroup,
      targets: this.targets,
      time,
      dt,
      view: this.cullView,
    };
    for (const s of this.systems) {
      s.update?.(ctx);
    }

    if (this.shadowMap) {
      const pass = encoder.beginRenderPass({
        label: 'frame:shadow-pass',
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.shadowMap,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setBindGroup(0, this.shadowGlobalsBindGroup);
      for (const s of this.systems) {
        if (s.drawShadow) {
          pass.pushDebugGroup(s.name);
          s.drawShadow(pass);
          pass.popDebugGroup();
        }
      }
      pass.end();
    }

    const t = this.targets;
    const opaque = encoder.beginRenderPass({
      label: 'frame:opaque-pass',
      colorAttachments: [
        {
          view: t.color,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
        {
          view: t.velocity,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
        {
          view: t.id,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
      depthStencilAttachment: {
        view: t.depth,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    opaque.setBindGroup(0, this.globalsBindGroup);
    for (const s of this.systems) {
      if (s.drawOpaque) {
        opaque.pushDebugGroup(s.name);
        s.drawOpaque(opaque);
        opaque.popDebugGroup();
      }
    }
    opaque.end();

    for (const s of this.systems) {
      s.afterOpaque?.(ctx);
    }

    if (this.systems.some(s => s.drawTransparent)) {
      const pass = encoder.beginRenderPass({
        label: 'frame:transparent-pass',
        colorAttachments: [{view: t.color, loadOp: 'load', storeOp: 'store'}],
        depthStencilAttachment: {
          view: t.depth,
          depthReadOnly: true,
        },
      });
      pass.setBindGroup(0, this.globalsBindGroup);
      for (const s of this.systems) {
        if (s.drawTransparent) {
          pass.pushDebugGroup(s.name);
          s.drawTransparent(pass);
          pass.popDebugGroup();
        }
      }
      pass.end();
    }

    let image = t.color;
    for (const p of this.post) {
      image = p.run(ctx, image);
    }
    this.present?.(ctx, image, this.gpu.context.getCurrentTexture());
    d.queue.submit([encoder.finish({label: 'frame:commands'})]);
  }
}
