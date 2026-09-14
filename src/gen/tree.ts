// Branching growth for coral, sea whips and kelp: produces chains of points
// (xyz + radius) that the GPU mesh builder turns into smooth tubes.

import type {Rng} from '../core/rng.ts';

export type ChainPoint = [number, number, number, number];

export interface Chain {
  points: ChainPoint[];
  /** 0 for the trunk, increasing with each branching generation. */
  depth: number;
  /** Deepest generation in the tree, for normalising. */
  maxDepth: number;
}

export interface TreeOptions {
  radius: number;
  segmentLength: number;
  segmentsPerChain: [number, number];
  maxDepth: number;
  branchChance: number;
  branchAngle: [number, number];
  /** Random direction change per segment. */
  wander: number;
  /** Pull toward +Y per segment. */
  upBias: number;
  /** Pull away from the trunk axis per segment. */
  outward: number;
  radiusDecay: number;
  childRadius: number;
  minRadius: number;
  maxChains: number;
  /** Initial direction spread for multiple trunks. */
  trunks: number;
  trunkSpread: number;
}

type V3 = [number, number, number];

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function randomUnit(rng: Rng): V3 {
  const z = rng.range(-1, 1);
  const a = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), z, r * Math.sin(a)];
}

/** Rotates `v` away from itself by `angle` in a random direction. */
function deflect(rng: Rng, v: V3, angle: number): V3 {
  const u = randomUnit(rng);
  // Component of u perpendicular to v.
  const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const p = norm([u[0] - v[0] * d, u[1] - v[1] * d, u[2] - v[2] * d]);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return norm([v[0] * c + p[0] * s, v[1] * c + p[1] * s, v[2] * c + p[2] * s]);
}

export function growTree(rng: Rng, o: TreeOptions): Chain[] {
  const chains: Chain[] = [];
  const queue: {pos: V3; dir: V3; radius: number; depth: number}[] = [];
  for (let t = 0; t < o.trunks; t++) {
    const dir =
      o.trunks > 1
        ? deflect(rng, [0, 1, 0], rng.range(0, o.trunkSpread))
        : [0, 1, 0];
    queue.push({pos: [0, 0, 0], dir: dir as V3, radius: o.radius, depth: 0});
  }
  let maxDepth = 0;
  while (queue.length && chains.length < o.maxChains) {
    const start = queue.shift()!;
    const points: ChainPoint[] = [[...start.pos, start.radius]];
    let pos = start.pos;
    let dir = start.dir;
    let radius = start.radius;
    const segs = rng.int(o.segmentsPerChain[0], o.segmentsPerChain[1]);
    for (let s = 0; s < segs; s++) {
      const w = randomUnit(rng);
      const out = norm([pos[0], 0.0001, pos[2]]);
      dir = norm([
        dir[0] + w[0] * o.wander + out[0] * o.outward,
        dir[1] + w[1] * o.wander + o.upBias,
        dir[2] + w[2] * o.wander + out[2] * o.outward,
      ]);
      const len =
        o.segmentLength * rng.range(0.8, 1.2) * (1 - start.depth * 0.08);
      pos = [
        pos[0] + dir[0] * len,
        pos[1] + dir[1] * len,
        pos[2] + dir[2] * len,
      ];
      radius = Math.max(o.minRadius, radius * o.radiusDecay);
      points.push([...pos, radius]);
      if (
        start.depth < o.maxDepth &&
        s < segs - 1 &&
        rng.float() < o.branchChance &&
        chains.length + queue.length < o.maxChains
      ) {
        queue.push({
          pos,
          dir: deflect(rng, dir, rng.range(o.branchAngle[0], o.branchAngle[1])),
          radius: Math.max(o.minRadius, radius * o.childRadius),
          depth: start.depth + 1,
        });
      }
    }
    maxDepth = Math.max(maxDepth, start.depth);
    if (points.length >= 2) {
      chains.push({points, depth: start.depth, maxDepth: 0});
    }
  }
  for (const c of chains) {
    c.maxDepth = maxDepth;
  }
  return chains;
}

/** Packs chains into an aux buffer builder; returns patch params per chain. */
export class AuxBuilder {
  private data: number[] = [];

  addChain(points: ChainPoint[]): {offset: number; count: number} {
    const offset = this.data.length / 4;
    for (const p of points) {
      this.data.push(...p);
    }
    return {offset, count: points.length};
  }

  build(): Float32Array {
    return new Float32Array(this.data.length ? this.data : [0, 0, 0, 0]);
  }
}

export function chainsRadius(chains: Chain[]): number {
  let r = 0;
  for (const c of chains) {
    for (const p of c.points) {
      r = Math.max(r, Math.hypot(p[0], p[1], p[2]) + p[3]);
    }
  }
  return r;
}
