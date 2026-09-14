// Placement helpers: blue-noise scattering over the terrain with density
// rules, plus reef clusters that concentrate life around hero spots.

import type {Rng} from '../core/rng.ts';

export interface ScatterOptions {
  count: number;
  /** Minimum spacing between points of this set. */
  minDist: number;
  /** Area to sample: centre and radius. */
  center: [number, number];
  radius: number;
  /** Acceptance probability 0..1 at (x, z). */
  density: (x: number, z: number) => number;
  maxTries?: number;
}

export class SpatialHash {
  private cells = new Map<string, [number, number, number][]>();
  private cell: number;
  constructor(cell: number) {
    this.cell = cell;
  }
  private key(x: number, z: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }
  add(x: number, z: number, r: number) {
    const k = this.key(x, z);
    let list = this.cells.get(k);
    if (!list) {
      list = [];
      this.cells.set(k, list);
    }
    list.push([x, z, r]);
  }
  /** True if a disc at (x, z) with radius r overlaps anything. */
  overlaps(x: number, z: number, r: number): boolean {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const span = Math.ceil((r * 2) / this.cell) + 1;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const list = this.cells.get(`${cx + dx},${cz + dz}`);
        if (!list) {
          continue;
        }
        for (const [px, pz, pr] of list) {
          if (Math.hypot(px - x, pz - z) < r + pr) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

/** Dart throwing with a density function. */
export function scatter(
  rng: Rng,
  o: ScatterOptions,
  occupied?: SpatialHash,
): [number, number][] {
  const out: [number, number][] = [];
  const own = new SpatialHash(Math.max(o.minDist, 0.5));
  const tries = o.maxTries ?? o.count * 30;
  for (let i = 0; i < tries && out.length < o.count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * o.radius;
    const x = o.center[0] + Math.cos(a) * r;
    const z = o.center[1] + Math.sin(a) * r;
    if (rng.float() > o.density(x, z)) {
      continue;
    }
    if (own.overlaps(x, z, o.minDist / 2)) {
      continue;
    }
    if (occupied?.overlaps(x, z, o.minDist / 2)) {
      continue;
    }
    own.add(x, z, o.minDist / 2);
    out.push([x, z]);
  }
  return out;
}
