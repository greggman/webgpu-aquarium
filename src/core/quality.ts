// Quality tiers. The tier is picked from the device and URL, then dynamic
// resolution adjusts the render scale at runtime to hold the frame rate.

export type Tier = 'mobile' | 'medium' | 'high' | 'ultra';

export interface Quality {
  tier: Tier;
  tierIndex: number;
  /** Initial fraction of canvas resolution to render at. */
  renderScale: number;
  minRenderScale: number;
  maxRenderScale: number;
  /** Largest canvas dimension in device pixels. */
  maxCanvasPixels: number;
  terrainGrid: number;
  shadowSize: number;
  volumetrics: 'high' | 'medium' | 'low';
  volumetricSteps: number;
  bloom: boolean;
  dof: boolean;
  taa: boolean;
  grain: boolean;
  /** Multiplier for creature/plant counts. */
  density: number;
  /**
   * Build the detailed meshes and the larger scatter counts. Not the same
   * question as "is this a fast machine": a phone draws about a sixth of the
   * pixels of a 1080p window, and the frame is dominated by shading them, so a
   * phone can afford detail that a low-end desktop at full resolution cannot.
   */
  detail: boolean;
  causticsSize: number;
  /** Refresh the caustics one frame in this many. */
  causticsStride: number;
  targetFrameMs: number;
}

const TIERS: Record<Tier, Omit<Quality, 'tier' | 'tierIndex'>> = {
  mobile: {
    // Phones render in CSS pixels (a third to a quarter of their device
    // pixels) already, so a frame is a sixth of a 1080p one. Measured on an
    // iPhone 15 Pro, the opaque pass is about 80% of the frame and is bound by
    // shading pixels, not by triangles: the shadow pass puts through more
    // geometry in an eighth of the time. So buy content and spend the savings
    // on resolution, which is the cheapest thing here to give up.
    renderScale: 0.85,
    minRenderScale: 0.5,
    maxRenderScale: 1,
    maxCanvasPixels: 1600 * 900,
    terrainGrid: 256,
    shadowSize: 1024,
    volumetrics: 'low',
    volumetricSteps: 10,
    bloom: true,
    dof: false,
    taa: true,
    grain: false,
    density: 0.85,
    detail: true,
    causticsSize: 256,
    causticsStride: 2,
    // Aim for 60, not 30: the same phone holds 60 on the high tier at 75%
    // scale, so there is no reason to settle for half of it.
    targetFrameMs: 1000 / 60,
  },
  medium: {
    renderScale: 0.8,
    minRenderScale: 0.55,
    maxRenderScale: 1,
    maxCanvasPixels: 1920 * 1080,
    terrainGrid: 256,
    shadowSize: 1536,
    volumetrics: 'medium',
    volumetricSteps: 16,
    bloom: true,
    dof: false,
    taa: true,
    grain: true,
    density: 0.6,
    detail: false,
    causticsSize: 512,
    causticsStride: 2,
    targetFrameMs: 1000 / 60,
  },
  high: {
    // Rendered below native and upscaled (TAA plus sharpening), as games do:
    // most of the frame cost is per pixel.
    renderScale: 0.8,
    minRenderScale: 0.6,
    maxRenderScale: 0.85,
    maxCanvasPixels: 1920 * 1080,
    terrainGrid: 512,
    shadowSize: 2048,
    volumetrics: 'high',
    volumetricSteps: 18,
    bloom: true,
    dof: true,
    taa: true,
    grain: true,
    density: 1,
    detail: true,
    causticsSize: 512,
    causticsStride: 1,
    targetFrameMs: 1000 / 60,
  },
  ultra: {
    renderScale: 0.9,
    minRenderScale: 0.7,
    maxRenderScale: 1,
    maxCanvasPixels: 2560 * 1440,
    terrainGrid: 512,
    shadowSize: 2048,
    volumetrics: 'high',
    volumetricSteps: 24,
    bloom: true,
    dof: true,
    taa: true,
    grain: true,
    density: 1.3,
    detail: true,
    causticsSize: 1024,
    causticsStride: 1,
    targetFrameMs: 1000 / 60,
  },
};

const ORDER: Tier[] = ['mobile', 'medium', 'high', 'ultra'];

export function detectTier(
  info: GPUAdapterInfo,
  override?: string | null,
): Tier {
  if (override && override in TIERS) {
    return override as Tier;
  }
  const ua = navigator.userAgent;
  const touchPrimary = matchMedia('(pointer: coarse)').matches;
  const phoneLike =
    /iPhone|iPad|Android|Mobile/i.test(ua) ||
    (touchPrimary && Math.min(screen.width, screen.height) < 900);
  if (phoneLike) {
    return 'mobile';
  }
  const vendor = `${info.vendor} ${info.architecture}`.toLowerCase();
  if (/intel/.test(vendor) && !/arc/.test(vendor)) {
    return 'medium';
  }
  return 'high';
}

export function getQuality(tier: Tier): Quality {
  return {tier, tierIndex: ORDER.indexOf(tier), ...TIERS[tier]};
}

/** Adjusts render scale to track the frame time target. */
export class DynamicResolution {
  scale: number;
  private avg = 0;
  private cooldown = 0;
  private q: Quality;

  constructor(q: Quality) {
    this.q = q;
    this.scale = q.renderScale;
  }

  /** Returns true when the scale changed. */
  update(frameMs: number): boolean {
    this.avg = this.avg ? this.avg * 0.95 + frameMs * 0.05 : frameMs;
    if (--this.cooldown > 0) {
      return false;
    }
    const target = this.q.targetFrameMs;
    let next = this.scale;
    if (this.avg > target * 1.2) {
      next = Math.max(this.q.minRenderScale, this.scale - 0.05);
    } else if (this.avg < target * 0.8) {
      next = Math.min(this.q.maxRenderScale, this.scale + 0.05);
    }
    if (next !== this.scale) {
      this.scale = next;
      this.cooldown = 90;
      return true;
    }
    return false;
  }
}
