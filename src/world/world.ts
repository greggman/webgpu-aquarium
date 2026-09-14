// World description: everything chosen per seed that isn't a mesh.
// Water colour, sun, the terrain basin, the play area, and camera spots.

import {Rng} from '../core/rng.ts';
import type {Vec3} from '../math/vec3.ts';
import {NavVolume} from '../player/navvolume.ts';
import type {TourStop} from '../player/attract.ts';
import {
  randomTerrainSettings,
  type TerrainData,
  type TerrainSettings,
} from '../gen/terrain.ts';
import type {GradeSettings} from '../render/post/present.ts';

export interface WaterStyle {
  name: string;
  absorption: Vec3;
  scattering: number;
  ambient: Vec3;
  sunColor: Vec3;
  exposure: number;
  grade: GradeSettings;
}

const STYLES: WaterStyle[] = [
  {
    name: 'tropical',
    absorption: [0.11, 0.036, 0.022],
    scattering: 0.018,
    ambient: [0.3, 0.75, 1.05],
    sunColor: [13, 12.4, 11.2],
    exposure: 0.36,
    grade: {
      lift: [0.0, 0.004, 0.01],
      gamma: [1.0, 1.0, 1.0],
      gain: [1.03, 1.0, 0.97],
      saturation: 1.12,
      contrast: 1.08,
      vignette: 0.55,
      grain: 0.35,
      bloom: 0.06,
    },
  },
  {
    name: 'lagoon',
    absorption: [0.14, 0.032, 0.03],
    scattering: 0.024,
    ambient: [0.32, 0.85, 0.92],
    sunColor: [13, 12.6, 11.4],
    exposure: 0.34,
    grade: {
      lift: [0.0, 0.006, 0.006],
      gamma: [1.0, 1.0, 1.0],
      gain: [1.04, 1.0, 0.96],
      saturation: 1.1,
      contrast: 1.06,
      vignette: 0.5,
      grain: 0.35,
      bloom: 0.06,
    },
  },
  {
    name: 'deep-blue',
    absorption: [0.16, 0.045, 0.022],
    scattering: 0.016,
    ambient: [0.18, 0.52, 1.15],
    sunColor: [12.5, 12.5, 12],
    exposure: 0.42,
    grade: {
      lift: [0.0, 0.0, 0.012],
      gamma: [1.0, 1.0, 1.02],
      gain: [1.05, 1.0, 0.95],
      saturation: 1.1,
      contrast: 1.1,
      vignette: 0.6,
      grain: 0.35,
      bloom: 0.06,
    },
  },
  {
    name: 'kelp-forest',
    absorption: [0.15, 0.04, 0.06],
    scattering: 0.03,
    ambient: [0.34, 0.8, 0.6],
    sunColor: [12.5, 12.2, 10],
    exposure: 0.38,
    grade: {
      lift: [0.004, 0.006, 0.0],
      gamma: [1.0, 1.0, 1.0],
      gain: [1.04, 1.0, 0.94],
      saturation: 1.05,
      contrast: 1.08,
      vignette: 0.6,
      grain: 0.4,
      bloom: 0.07,
    },
  },
];

export interface CameraSpot {
  pos: Vec3;
  target: Vec3;
}

export interface WorldDesc {
  seed: number;
  rng: Rng;
  surfaceY: number;
  water: WaterStyle;
  /** Direction toward the sun, in water. */
  sunDir: Vec3;
  terrain: TerrainSettings;
}

export function describeWorld(seed: number): WorldDesc {
  const rng = new Rng(seed);
  const surfaceY = 0;
  const base = rng.pick(STYLES);
  const jitter = (v: Vec3, amt: number): Vec3 =>
    v.map(x => x * (1 + rng.range(-amt, amt))) as Vec3;
  const water: WaterStyle = {
    ...base,
    absorption: jitter(base.absorption, 0.12),
    scattering: base.scattering * rng.range(0.85, 1.2),
    ambient: jitter(base.ambient, 0.08),
  };

  // Sun in the air, then refracted into the water (Snell's law).
  const elevation = rng.range(0.95, 1.25); // radians above horizon
  const azimuth = rng.range(0, Math.PI * 2);
  const zenithAir = Math.PI / 2 - elevation;
  const zenithWater = Math.asin(Math.sin(zenithAir) / 1.333);
  const sunDir: Vec3 = [
    Math.cos(azimuth) * Math.sin(zenithWater),
    Math.cos(zenithWater),
    Math.sin(azimuth) * Math.sin(zenithWater),
  ];

  const terrain = randomTerrainSettings(rng.fork('terrain'), surfaceY);
  return {seed, rng, surfaceY, water, sunDir, terrain};
}

/** Builds the play area from generated terrain. */
export function buildNavVolume(
  desc: WorldDesc,
  terrain: TerrainData,
): NavVolume {
  const t = desc.terrain;
  const ceilingGap = 3.2;
  const floorClearance = 1.4;
  const ceiling = desc.surfaceY - ceilingGap;
  const samples = 96;
  const radii = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    let r = 4;
    const maxR = t.basinRadius + 12;
    // March outward until the ground rises too close to the ceiling.
    while (r < maxR) {
      const g = terrain.heightAt(t.center[0] + cx * r, t.center[1] + cz * r);
      if (g + floorClearance > ceiling - 3) {
        break;
      }
      r += 0.5;
    }
    radii[i] = Math.max(8, r - 5);
  }
  // Smooth around the ring so the boundary has no sharp notches.
  const smooth = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    let wsum = 0;
    for (let k = -3; k <= 3; k++) {
      const w = 4 - Math.abs(k);
      sum += radii[(i + k + samples) % samples] * w;
      wsum += w;
    }
    smooth[i] = Math.min(sum / wsum, radii[i] + 2);
  }
  const radiusAt = (angle: number) => {
    const u = (((angle / (Math.PI * 2)) % 1) + 1) % 1;
    const f = u * samples;
    const i = Math.floor(f);
    const k = f - i;
    return smooth[i % samples] * (1 - k) + smooth[(i + 1) % samples] * k;
  };
  return new NavVolume({
    heightAt: (x, z) => terrain.heightAt(x, z),
    center: t.center,
    radiusAt,
    surfaceY: desc.surfaceY,
    ceilingGap,
    floorClearance,
    softZone: 10,
  });
}

/** Finds the best-scoring terrain location among random candidates. */
function bestSpot(
  rng: Rng,
  nav: NavVolume,
  score: (x: number, z: number) => number,
  tries = 300,
): [number, number] {
  let best: [number, number] = [0, 0];
  let bestScore = -Infinity;
  const c = nav.o.center;
  for (let i = 0; i < tries; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * nav.o.radiusAt(a) * 0.85;
    const x = c[0] + Math.cos(a) * r;
    const z = c[1] + Math.sin(a) * r;
    const s = score(x, z);
    if (s > bestScore) {
      bestScore = s;
      best = [x, z];
    }
  }
  return best;
}

/** Places a camera `dist` metres from a target, `height` above the ground, inside the volume. */
function spotLookingAt(
  nav: NavVolume,
  terrain: TerrainData,
  target: Vec3,
  dist: number,
  height: number,
  preferredAngle: number,
): CameraSpot {
  let fallback: CameraSpot | null = null;
  for (let k = 0; k < 16; k++) {
    const a = preferredAngle + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.4;
    const x = target[0] + Math.cos(a) * dist;
    const z = target[2] + Math.sin(a) * dist;
    const y = Math.min(
      Math.max(terrain.heightAt(x, z), target[1] - 1) + height,
      nav.ceiling() - 0.5,
    );
    const pos: Vec3 = [x, Math.max(y, nav.floorAt(x, z) + 0.2), z];
    const spot = {pos, target};
    fallback ??= spot;
    if (nav.contains(pos) && nav.edgeFactor(x, z) < 0.3) {
      return spot;
    }
  }
  return fallback!;
}

export function cameraSpots(
  desc: WorldDesc,
  terrain: TerrainData,
  nav: NavVolume,
): {presets: Record<string, CameraSpot>; tour: TourStop[]} {
  const rng = new Rng(desc.seed ^ 0xca3e7a);
  const c = desc.terrain.center;
  const gapA = desc.terrain.gapAngle;
  const ground = (x: number, z: number): Vec3 => [x, terrain.heightAt(x, z), z];

  // Reef: rocky outcrop with reef growth.
  const [rx, rz] = bestSpot(
    rng,
    nav,
    (x, z) =>
      terrain.maskAt(1, x, z) * 1.2 +
      terrain.maskAt(0, x, z) +
      terrain.heightAt(x, z) * 0.02,
  );
  const reefTarget = ground(rx, rz);
  reefTarget[1] += 1.2;
  const reef = spotLookingAt(
    nav,
    terrain,
    reefTarget,
    9,
    2.2,
    Math.atan2(c[1] - rz, c[0] - rx) + 0.6,
  );

  // Kelp: flat sandy patch with kelp mask.
  const [kx, kz] = bestSpot(
    rng,
    nav,
    (x, z) => terrain.maskAt(2, x, z) - terrain.maskAt(0, x, z) * 0.5,
  );
  const kelpTarget = ground(kx, kz);
  kelpTarget[1] += 3;
  const kelp = spotLookingAt(
    nav,
    terrain,
    kelpTarget,
    11,
    1.8,
    rng.range(0, Math.PI * 2),
  );

  // Wide: from the far side of the basin toward the gap into the deep.
  const wa = gapA + Math.PI;
  const wr = nav.o.radiusAt(wa) * 0.8;
  const wx = c[0] + Math.cos(wa) * wr;
  const wz = c[1] + Math.sin(wa) * wr;
  const wy = Math.min(terrain.heightAt(wx, wz) + 7, nav.ceiling() - 1);
  const wide: CameraSpot = {
    pos: [wx, Math.max(wy, nav.floorAt(wx, wz)), wz],
    target: [
      c[0] + Math.cos(gapA) * 30,
      terrain.heightAt(c[0], c[1]) + 1,
      c[1] + Math.sin(gapA) * 30,
    ],
  };

  // Overhead: high above the reef looking down at it.
  const overhead: CameraSpot = {
    pos: [rx + 6, nav.ceiling() - 0.5, rz + 4],
    target: reefTarget,
  };

  const presets = {reef, kelp, wide, overhead};

  // Tour: loop around the basin, alternating low and high passes over interesting spots.
  const tour: TourStop[] = [];
  const stops = 8;
  const start = rng.range(0, Math.PI * 2);
  for (let i = 0; i < stops; i++) {
    const a = start + (i / stops) * Math.PI * 2;
    const R = nav.o.radiusAt(a) * rng.range(0.35, 0.7);
    const x = c[0] + Math.cos(a) * R;
    const z = c[1] + Math.sin(a) * R;
    const high = i % 3 === 1;
    const y = Math.min(
      nav.floorAt(x, z) + (high ? rng.range(6, 10) : rng.range(1.2, 3)),
      nav.ceiling() - 0.5,
    );
    const ahead = a + (Math.PI * 2) / stops;
    const tR = nav.o.radiusAt(ahead) * rng.range(0.2, 0.6);
    const tx = c[0] + Math.cos(ahead) * tR;
    const tz = c[1] + Math.sin(ahead) * tR;
    tour.push({
      pos: [x, y, z],
      target: [tx, terrain.heightAt(tx, tz) + (high ? 0 : 2), tz],
    });
  }
  return {presets, tour};
}
