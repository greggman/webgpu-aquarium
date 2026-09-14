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
  /** Sun elevation above the horizon in air, radians [min, max]. */
  sunElevation: [number, number];
  exposure: number;
  grade: GradeSettings;
}

const grade = (g: Partial<GradeSettings>): GradeSettings => ({
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  saturation: 1.2,
  contrast: 1.18,
  vignette: 0.75,
  grain: 0.35,
  bloom: 0.06,
  ...g,
});

const STYLES: WaterStyle[] = [
  {
    // Clear tropical shallows: bright turquoise-blue, warm sand.
    name: 'tropical',
    absorption: [0.1, 0.034, 0.02],
    scattering: 0.016,
    ambient: [0.26, 0.72, 1.1],
    sunColor: [14, 13.2, 11.8],
    sunElevation: [1.05, 1.3],
    exposure: 0.36,
    grade: grade({
      lift: [0, 0.004, 0.012],
      gain: [1.05, 1.0, 0.95],
      saturation: 1.25,
    }),
  },
  {
    // Emerald lagoon: green-teal water.
    name: 'lagoon',
    absorption: [0.12, 0.028, 0.03],
    scattering: 0.02,
    ambient: [0.24, 0.76, 0.9],
    sunColor: [13.5, 13, 10.8],
    sunElevation: [0.95, 1.25],
    exposure: 0.36,
    grade: grade({lift: [0.004, 0.008, 0.0], gain: [1.06, 1.0, 0.92]}),
  },
  {
    // Deep indigo open-ocean blue with high contrast.
    name: 'deep-blue',
    absorption: [0.17, 0.05, 0.02],
    scattering: 0.014,
    ambient: [0.12, 0.42, 1.2],
    sunColor: [13, 13, 12.5],
    sunElevation: [1.0, 1.3],
    exposure: 0.44,
    grade: grade({
      lift: [0, 0, 0.016],
      gamma: [1, 1, 1.04],
      gain: [1.08, 1.0, 0.92],
      contrast: 1.25,
    }),
  },
  {
    // Kelp coast: murky green-gold, softer light.
    name: 'kelp-forest',
    absorption: [0.14, 0.042, 0.05],
    scattering: 0.024,
    ambient: [0.27, 0.66, 0.64],
    sunColor: [13, 12, 9],
    sunElevation: [0.85, 1.15],
    exposure: 0.4,
    grade: grade({
      lift: [0.008, 0.008, 0.0],
      gain: [1.08, 1.0, 0.88],
      saturation: 1.1,
      grain: 0.45,
      bloom: 0.07,
    }),
  },
  {
    // Golden hour: low warm sun, violet-blue depths.
    name: 'golden-hour',
    absorption: [0.12, 0.04, 0.028],
    scattering: 0.02,
    ambient: [0.2, 0.42, 0.85],
    sunColor: [16, 11.5, 6.5],
    sunElevation: [0.45, 0.7],
    exposure: 0.5,
    grade: grade({
      lift: [0.012, 0.004, 0.018],
      gain: [1.1, 1.0, 0.9],
      saturation: 1.2,
      contrast: 1.22,
      bloom: 0.08,
    }),
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

export function describeWorld(
  seed: number,
  styleOverride?: string | null,
): WorldDesc {
  const rng = new Rng(seed);
  const surfaceY = 0;
  const base = STYLES.find(s => s.name === styleOverride) ?? rng.pick(STYLES);
  const jitter = (v: Vec3, amt: number): Vec3 =>
    v.map(x => x * (1 + rng.range(-amt, amt))) as Vec3;
  const water: WaterStyle = {
    ...base,
    absorption: jitter(base.absorption, 0.1),
    scattering: base.scattering * rng.range(0.85, 1.15),
    ambient: jitter(base.ambient, 0.06),
  };

  // Sun in the air, then refracted into the water (Snell's law).
  const elevation = rng.range(...base.sunElevation);
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
  clusters: {x: number; y: number; z: number; radius: number}[],
  kelpForests: {x: number; z: number; radius: number}[] = [],
): {presets: Record<string, CameraSpot>; tour: TourStop[]} {
  const rng = new Rng(desc.seed ^ 0xca3e7a);
  const c = desc.terrain.center;
  const gapA = desc.terrain.gapAngle;
  const ground = (x: number, z: number): Vec3 => [x, terrain.heightAt(x, z), z];
  const hero = clusters[0] ?? {
    x: c[0],
    z: c[1],
    y: terrain.heightAt(c[0], c[1]),
    radius: 5,
  };

  // Reef: the hero cluster, from slightly above.
  // Low and looking slightly up toward the open water of the gap, so the reef
  // silhouettes against the blue instead of sitting on flat sand.
  const reefTarget: Vec3 = [hero.x, hero.y + 1.5, hero.z];
  const reef = spotLookingAt(
    nav,
    terrain,
    reefTarget,
    hero.radius + 3.5,
    1.1,
    gapA + Math.PI + 0.35,
  );

  // Kelp: flat sandy patch with kelp mask.
  const [kx, kz] = kelpForests.length
    ? [kelpForests[0].x, kelpForests[0].z]
    : bestSpot(
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

  // Wide: an establishing shot across the hero reef toward the gap into the deep.
  const away = gapA + Math.PI;
  const wide = spotLookingAt(
    nav,
    terrain,
    [hero.x + Math.cos(gapA) * 10, hero.y + 2.5, hero.z + Math.sin(gapA) * 10],
    26,
    2.2,
    away,
  );

  // Overhead: high above the reef looking down at it.
  const overhead: CameraSpot = {
    pos: [hero.x + 5, nav.ceiling() - 0.5, hero.z + 3],
    target: reefTarget,
  };

  // Surface: low beside the hero reef, looking up toward the sun through the
  // shafts at Snell's window.
  const sunFlat = Math.atan2(desc.sunDir[2], desc.sunDir[0]);
  const upX = hero.x - Math.cos(sunFlat) * (hero.radius + 2);
  const upZ = hero.z - Math.sin(sunFlat) * (hero.radius + 2);
  const upY = Math.min(nav.floorAt(upX, upZ) + 0.6, nav.ceiling() - 2);
  const surface: CameraSpot = {
    pos: [upX, upY, upZ],
    target: [upX + Math.cos(sunFlat) * 5, upY + 6, upZ + Math.sin(sunFlat) * 5],
  };

  const presets = {reef, kelp, wide, overhead, surface};

  // Tour: visit the reef clusters (and the kelp) in order around the basin,
  // alternating low and high passes.
  const stopsAt = [
    ...clusters.map(k => ({x: k.x, y: k.y, z: k.z, r: k.radius})),
    {x: kx, y: kelpTarget[1] - 3, z: kz, r: 4},
  ];
  stopsAt.sort(
    (a, b) =>
      Math.atan2(a.z - c[1], a.x - c[0]) - Math.atan2(b.z - c[1], b.x - c[0]),
  );
  const tour: TourStop[] = [];
  stopsAt.forEach((k, i) => {
    const high = i % 3 === 1;
    const angle = Math.atan2(c[1] - k.z, c[0] - k.x) + rng.range(-0.8, 0.8);
    const spot = spotLookingAt(
      nav,
      terrain,
      [k.x, k.y + (high ? 0.5 : 1.5), k.z],
      k.r + (high ? 9 : 5),
      high ? 7 : 2,
      angle,
    );
    tour.push({pos: spot.pos, target: spot.target});
  });
  if (tour.length < 3) {
    tour.push(
      {pos: wide.pos, target: wide.target},
      {pos: reef.pos, target: reef.target},
    );
  }
  return {presets, tour};
}
