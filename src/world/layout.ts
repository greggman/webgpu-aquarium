// High-level layout of life in the basin: where the hero reef clusters go, and
// the shared context every content generator receives.

import {Rng, hash32} from '../core/rng.ts';
import type {Quality} from '../core/quality.ts';
import type {TerrainData} from '../gen/terrain.ts';
import type {NavVolume, NavSphere} from '../player/navvolume.ts';
import type {WorldDesc} from './world.ts';
import {SpatialHash} from './scatter.ts';

export interface ReefCluster {
  x: number;
  z: number;
  y: number;
  radius: number;
  /** 0 = biggest / most important */
  rank: number;
}

export interface KelpForest {
  x: number;
  z: number;
  radius: number;
  /** Holdfast positions. */
  stems: [number, number][];
}

export interface Clearing {
  x: number;
  z: number;
  radius: number;
}

export interface Landmark {
  kind: 'pinnacle';
  x: number;
  y: number;
  z: number;
  /** Metres above the seabed. */
  height: number;
  radius: number;
}

export interface GenContext {
  desc: WorldDesc;
  terrain: TerrainData;
  nav: NavVolume;
  quality: Quality;
  clusters: ReefCluster[];
  /** Footprints of large objects already placed. */
  occupied: SpatialHash;
  /** Solid obstacles the camera must avoid. */
  obstacles: NavSphere[];
  /** Kelp forest locations (filled in by the plant generator). */
  kelpForests: KelpForest[];
  /** Tall thin props (x, base y, z, top y) that clutter a view if right in front of the lens. */
  tallProps: [number, number, number, number][];
  /** Tops of large coral heads (x, top y, z, radius): homes for hovering reef fish. */
  coralHeads: [number, number, number, number][];
  /** Anemone positions (filled in by the critter generator), homes for clownfish. */
  anemones: [number, number, number][];
  /** Open sand the reef grows around. */
  clearings: Clearing[];
  /** Big formations worth pointing a camera at (filled in by the rocks). */
  landmarks: Landmark[];
  /**
   * How much grows at (x, z), 0-1: zero inside a clearing, and varying
   * elsewhere so the seabed is patchy rather than an even carpet. Every
   * generator multiplies its own density by this.
   */
  open(x: number, z: number): number;
  /** A generator stream unique to `name`. */
  rng(name: string): Rng;
  /** Instance count scaled by quality. */
  count(n: number): number;
  groundY(x: number, z: number): number;
  /** Top of whatever is at (x, z): terrain or a large rock. */
  surfaceTop(x: number, z: number): number;
}

export function createGenContext(
  desc: WorldDesc,
  terrain: TerrainData,
  nav: NavVolume,
  quality: Quality,
): GenContext {
  const base = new Rng(desc.seed ^ 0x5eed1e55);
  const clusters = pickClusters(base.fork('clusters'), terrain, nav);
  const clearings = pickClearings(
    base.fork('clearings'),
    terrain,
    nav,
    clusters,
  );
  const patch = patchField(base.fork('patchiness').nextU32());
  const obstacles: NavSphere[] = [];
  return {
    desc,
    terrain,
    nav,
    quality,
    clusters,
    occupied: new SpatialHash(2),
    obstacles,
    kelpForests: [],
    tallProps: [],
    coralHeads: [],
    anemones: [],
    clearings,
    landmarks: [],
    open: (x, z) => {
      for (const c of clearings) {
        const d = Math.hypot(x - c.x, z - c.z);
        if (d < c.radius) {
          // Bare in the middle, thickening again over the outer third.
          const t = Math.max(0, (d - c.radius * 0.62) / (c.radius * 0.38));
          return t * t * patch(x, z);
        }
      }
      return patch(x, z);
    },
    surfaceTop: (x, z) => {
      let top = terrain.groundAt(x, z);
      for (const o of obstacles) {
        const d = Math.hypot(x - o.center[0], z - o.center[2]);
        const r = o.radius * 0.8;
        if (d < r) {
          top = Math.max(top, o.center[1] + Math.sqrt(r * r - d * d) * 0.75);
        }
      }
      return top;
    },
    rng: name => new Rng(desc.seed).fork(name),
    count: n => Math.max(1, Math.round(n * quality.density)),
    // What is drawn, not what the height map says: see TerrainData.groundAt.
    groundY: (x, z) => terrain.groundAt(x, z),
  };
}

/**
 * Clearings: patches of open sand, placed where the reef would otherwise grow
 * edge to edge. They give the eye somewhere to rest, somewhere for the light
 * to land, and something for the density elsewhere to read against.
 */
function pickClearings(
  rng: Rng,
  terrain: TerrainData,
  nav: NavVolume,
  clusters: ReefCluster[],
): Clearing[] {
  const c = nav.o.center;
  const out: Clearing[] = [];
  const want = rng.int(7, 11);
  for (let i = 0; i < 900 && out.length < want; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * nav.o.radiusAt(a) * 0.8;
    const x = c[0] + Math.cos(a) * r;
    const z = c[1] + Math.sin(a) * r;
    // Flat ground that something would otherwise cover; the first clearing is
    // the largest and sits beside the hero reef, where the cameras look.
    const first = out.length === 0;
    const hero = clusters[0];
    const near = hero
      ? Math.hypot(x - hero.x, z - hero.z)
      : Number.POSITIVE_INFINITY;
    if (first && hero && (near < hero.radius + 6 || near > hero.radius + 22)) {
      continue;
    }
    if (terrain.normalAt(x, z)[1] < 0.9) {
      continue;
    }
    const radius = first ? rng.range(9, 13) : rng.range(4.5, 9);
    // Never swallow a reef whole, and keep clearings apart.
    if (
      clusters.some(
        k => Math.hypot(k.x - x, k.z - z) < k.radius * 0.8 + radius * 0.5,
      ) ||
      out.some(k => Math.hypot(k.x - x, k.z - z) < k.radius + radius + 3)
    ) {
      continue;
    }
    out.push({x, z, radius});
  }
  return out;
}

/**
 * Smooth 0-1 noise on a ~20 m lattice, remapped so most of the basin grows
 * normally but some of it thins out.
 */
function patchField(seed: number): (x: number, z: number) => number {
  const at = (ix: number, iz: number) => {
    const h = hash32(ix * 374761393 + iz * 668265263 + seed);
    return (h >>> 8) / 0xffffff;
  };
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x, z) => {
    const px = x / 21;
    const pz = z / 21;
    const ix = Math.floor(px);
    const iz = Math.floor(pz);
    const fx = fade(px - ix);
    const fz = fade(pz - iz);
    const v =
      (at(ix, iz) * (1 - fx) + at(ix + 1, iz) * fx) * (1 - fz) +
      (at(ix, iz + 1) * (1 - fx) + at(ix + 1, iz + 1) * fx) * fz;
    // Thin patches by about half; the rest is full. Any lower and the world
    // reads as bare rather than varied.
    return Math.min(1, 0.55 + v * 1.0);
  };
}

function pickClusters(
  rng: Rng,
  terrain: TerrainData,
  nav: NavVolume,
): ReefCluster[] {
  const c = nav.o.center;
  const candidates: {x: number; z: number; score: number}[] = [];
  for (let i = 0; i < 1500; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * nav.o.radiusAt(a) * 0.82;
    const x = c[0] + Math.cos(a) * r;
    const z = c[1] + Math.sin(a) * r;
    const n = terrain.normalAt(x, z);
    if (n[1] < 0.72) {
      continue;
    }
    const score =
      terrain.maskAt(1, x, z) * 1.5 +
      terrain.maskAt(0, x, z) * 0.4 -
      terrain.maskAt(2, x, z) * 0.6 +
      rng.range(0, 0.4) -
      // Slight preference for spots that are not at the very edge.
      (r / nav.o.radiusAt(a)) * 0.3;
    candidates.push({x, z, score});
  }
  candidates.sort((a, b) => b.score - a.score);
  const clusters: ReefCluster[] = [];
  // Enough reefs that wherever the camera looks there is life in view.
  const want = rng.int(16, 20);
  for (const cand of candidates) {
    if (clusters.length >= want) {
      break;
    }
    const radius =
      clusters.length === 0 ? rng.range(11, 13) : rng.range(6, 9.5);
    if (
      clusters.some(
        k => Math.hypot(k.x - cand.x, k.z - cand.z) < k.radius + radius + 1,
      )
    ) {
      continue;
    }
    clusters.push({
      x: cand.x,
      z: cand.z,
      y: terrain.heightAt(cand.x, cand.z),
      radius,
      rank: clusters.length,
    });
  }
  return clusters;
}
