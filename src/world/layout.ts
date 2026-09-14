// High-level layout of life in the basin: where the hero reef clusters go, and
// the shared context every content generator receives.

import {Rng} from '../core/rng.ts';
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
  const obstacles: NavSphere[] = [];
  return {
    desc,
    terrain,
    nav,
    quality,
    clusters,
    occupied: new SpatialHash(2),
    obstacles,
    surfaceTop: (x, z) => {
      let top = terrain.heightAt(x, z);
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
    groundY: (x, z) => terrain.heightAt(x, z),
  };
}

function pickClusters(
  rng: Rng,
  terrain: TerrainData,
  nav: NavVolume,
): ReefCluster[] {
  const c = nav.o.center;
  const candidates: {x: number; z: number; score: number}[] = [];
  for (let i = 0; i < 600; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * nav.o.radiusAt(a) * 0.82;
    const x = c[0] + Math.cos(a) * r;
    const z = c[1] + Math.sin(a) * r;
    const n = terrain.normalAt(x, z);
    if (n[1] < 0.8) {
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
  const want = rng.int(5, 7);
  for (const cand of candidates) {
    if (clusters.length >= want) {
      break;
    }
    const radius = clusters.length === 0 ? rng.range(6, 8) : rng.range(3.5, 6);
    if (
      clusters.some(
        k => Math.hypot(k.x - cand.x, k.z - cand.z) < k.radius + radius + 6,
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
