// Fish and rays: procedural species, GPU boids, and swimming animation.
//
// Each seed invents a set of species (body shape, fins, colour pattern and
// behaviour). Meshes come from the GPU mesh builder, three detail levels per
// species. Fish swim in schools: a compute shader moves each school's leader
// (wandering, avoiding terrain, rocks and the camera) and every other fish
// holds its own slot in the leader's formation, so the cost per fish is
// constant however many there are. A second compute pass culls fish to the
// view and sorts the visible ones into per-species detail levels, which are
// drawn with GPU-written indirect draw calls.

import {createShader} from '../gpu/device.ts';
import {sidePlanes} from '../render/frustum.ts';
import {defineStruct} from '../gpu/structs.ts';
import {buildMesh, vertexLayout, type Patch} from '../gen/meshgen.ts';
import {surfaceLib} from '../shaders/index.ts';
import shapes from '../shaders/shapes.wgsl';
import propsWgsl from '../shaders/props.wgsl';
import type {Rng} from '../core/rng.ts';
import type {GenContext} from '../world/layout.ts';
import {
  DEPTH_FORMAT,
  HDR_FORMAT,
  VELOCITY_FORMAT,
  type FrameContext,
  type Renderer,
  type RenderSystem,
} from '../render/renderer.ts';

const SpeciesStruct = defineStruct('Species', {
  /** min/max height above ground, cruise speed, max speed */
  band: 'vec4f',
  /** cohesion, alignment, separation, neighbour distance */
  flock: 'vec4f',
  /** turn responsiveness, length, body type (0 fish, 1 ray), tail beats per body length */
  motion: 'vec4f',
  /** rgb, pattern type */
  colTop: 'vec4f',
  /** rgb, pattern frequency */
  colBelly: 'vec4f',
  /** rgb, iridescence */
  colAccent: 'vec4f',
  /** rgb, fin translucency */
  colFin: 'vec4f',
  /** wander, home pull, eye height, eye size */
  extra: 'vec4f',
  /** curiosity (0 shy .. 1 approaches the camera), fear radius, roam radius, roam angular speed */
  behavior: 'vec4f',
  /** dart acceleration (0 = never darts), seconds between darts, unused, unused */
  dart: 'vec4f',
  /** formation radius, elongation along the heading, spring strength, drift */
  school: 'vec4f',
});

const FishStruct = defineStruct('Fish', {
  pos: 'vec3f',
  species: 'f32',
  vel: 'vec3f',
  phase: 'f32',
  home: 'vec4f',
  /** index of the school's leader (itself for leaders), unused xyz */
  leader: 'vec4f',
});

const FishInstanceStruct = defineStruct('FishInstance', {
  posScale: 'vec4f',
  rot: 'vec4f',
  prevPosScale: 'vec4f',
  prevRot: 'vec4f',
  /** phase, previous phase, normalised speed, species */
  anim: 'vec4f',
  /** individual tint variation rgb, unused */
  tint: 'vec4f',
});

const SimStruct = defineStruct('Sim', {
  dt: 'f32',
  time: 'f32',
  count: 'u32',
  obstacleCount: 'u32',
  camPos: 'vec3f',
  ceiling: 'f32',
  camDir: 'vec3f',
  worldSize: 'f32',
});

export const Pattern = {
  Countershade: 0,
  Bands: 1,
  Stripe: 2,
  Spots: 3,
  Gradient: 4,
  Clown: 5,
} as const;

type Home = 'open' | 'reef' | 'anemone' | 'basin' | 'kelp' | 'coral';

interface SpeciesDef {
  name: string;
  count: number;
  length: [number, number];
  bodyType: 0 | 1;
  body: number[];
  colors: {
    top: number[];
    belly: number[];
    accent: number[];
    fin: number[];
  };
  pattern: number;
  patternFreq: number;
  iridescence: number;
  finTranslucency: number;
  band: [number, number];
  speed: number;
  maxSpeed: number;
  flock: [number, number, number, number];
  turn: number;
  tailBeat: number;
  wander: number;
  homePull: number;
  home: Home;
  homeRadius: number;
  eye: number;
  /** 0 = shy; higher values hang around in front of the camera. */
  curiosity?: number;
  /** Radius (m) of a slow loop the school's home travels, stretching it into a ribbon. */
  roam?: number;
  /** Sudden bursts of speed: acceleration and mean seconds between them. */
  dart?: [number, number];
  /** Fish per school (1 = solitary). */
  school?: number;
  /** How loosely the school holds formation (1 = tight). */
  spread?: number;
}

const hsv = (h: number, s: number, v: number): number[] => {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
};

/** Coral heads that host hovering reef fish, nearest the hero reef first. */
function coralHomesFor(ctx: GenContext): [number, number, number, number][] {
  const hero = ctx.clusters[0];
  return [...ctx.coralHeads].sort((a, b) =>
    hero
      ? Math.hypot(a[0] - hero.x, a[2] - hero.z) -
        Math.hypot(b[0] - hero.x, b[2] - hero.z)
      : 0,
  );
}

/** Species school parameters: formation radius, elongation, spring, drift. */
function schoolParams(s: SpeciesDef): [number, number, number, number] {
  const size = Math.max(1, s.school ?? 1);
  const len = (s.length[0] + s.length[1]) / 2;
  const spread = s.spread ?? 1;
  const radius = Math.max(len * 2.2 * Math.cbrt(size) * 0.62 * spread, 0.25);
  // Roaming schools string out along their heading.
  const elongation = s.roam ? 2.2 : 1.1;
  // Tight schools snap into place; loose groups mill around.
  const spring = spread > 1.5 ? 0.7 : 1.4;
  return [radius, elongation, spring, Math.min(1, 0.15 + (spread - 1) * 0.5)];
}

/** Invents this seed's species. */
function inventSpecies(rng: Rng, ctx: GenContext): SpeciesDef[] {
  // A lush sea: tens of thousands of fish (scaled down more steeply on
  // smaller tiers, where each one costs relatively more).
  const k = Math.pow(ctx.quality.density, 1.5) * 10;
  const list: SpeciesDef[] = [];
  const body = (
    H: number,
    W: number,
    blunt: number,
    peduncle: number,
    tailSpan: number,
    fork: number,
    dorsal: number,
    anal: number,
    pectoral: number,
    dorsalStart: number,
    dorsalEnd: number,
    superellipse: number,
  ) => [
    H,
    W,
    blunt,
    peduncle,
    tailSpan,
    fork,
    dorsal,
    anal,
    pectoral,
    dorsalStart,
    dorsalEnd,
    superellipse,
  ];

  // Schooling bait fish over open water.
  const baitHue = rng.range(0.52, 0.62);
  list.push({
    name: 'bait',
    count: Math.round(rng.int(480, 700) * k),
    school: rng.int(250, 450),
    length: [0.2, 0.28],
    bodyType: 0,
    body: body(
      0.17,
      0.09,
      0.7,
      0.18,
      0.2,
      0.7,
      0.07,
      0.04,
      0.07,
      0.3,
      0.55,
      2.2,
    ),
    colors: {
      top: hsv(baitHue, 0.5, 0.35),
      belly: [0.9, 0.92, 0.95],
      accent: hsv(baitHue + rng.range(-0.05, 0.1), 0.6, 0.95),
      fin: [0.7, 0.75, 0.8],
    },
    pattern: Pattern.Stripe,
    patternFreq: 1,
    iridescence: 0.9,
    finTranslucency: 0.8,
    band: [2.5, 9],
    speed: 1.3,
    maxSpeed: 3.2,
    flock: [0.8, 1.8, 1.2, 1.6],
    turn: 2,
    tailBeat: 1.6,
    wander: 0.3,
    homePull: 0.15,
    home: 'open',
    homeRadius: 6,
    roam: 9,
    eye: 0.035,
  });

  // Colourful reef fish that loiter around coral clusters.
  // Every archetype, plus a couple in a second colour form.
  const allArchetypes = ['tang', 'butterfly', 'damsel', 'parrot', 'wrasse'];
  const reefArchetypes = [
    ...rng.shuffle([...allArchetypes]),
    ...rng.shuffle([...allArchetypes]).slice(0, 2),
  ];
  for (const a of reefArchetypes) {
    const hue = rng.float();
    if (a === 'tang') {
      list.push({
        name: a,
        count: Math.round(rng.int(20, 32) * k),
        school: rng.int(6, 12),
        spread: 1.6,
        length: [0.32, 0.46],
        bodyType: 0,
        body: body(
          0.36,
          0.07,
          0.5,
          0.14,
          0.32,
          0.35,
          0.12,
          0.1,
          0.1,
          0.22,
          0.85,
          2.0,
        ),
        colors: {
          top: hsv(hue, 0.85, 0.75),
          belly: hsv(hue, 0.7, 0.85),
          accent: hsv(hue + 0.15, 0.9, 0.9),
          fin: hsv(hue + 0.1, 0.9, 0.8),
        },
        pattern: rng.pick([Pattern.Gradient, Pattern.Countershade]),
        patternFreq: 1,
        iridescence: 0.2,
        finTranslucency: 0.4,
        band: [0.6, 4],
        speed: 0.6,
        maxSpeed: 2,
        flock: [0.2, 0.5, 1.2, 2.5],
        turn: 1.5,
        tailBeat: 1.2,
        wander: 0.5,
        homePull: 0.25,
        home: 'reef',
        homeRadius: 4,
        eye: 0.03,
      });
    } else if (a === 'butterfly') {
      list.push({
        name: a,
        count: Math.round(rng.int(14, 22) * k),
        // Butterflyfish swim in pairs.
        school: 2,
        spread: 1.4,
        length: [0.22, 0.32],
        bodyType: 0,
        body: body(
          0.5,
          0.06,
          0.6,
          0.12,
          0.26,
          0.05,
          0.16,
          0.14,
          0.09,
          0.2,
          0.85,
          2.0,
        ),
        colors: {
          top: [0.95, 0.85, 0.2],
          belly: [0.95, 0.95, 0.9],
          accent: [0.08, 0.08, 0.1],
          fin: [0.95, 0.8, 0.2],
        },
        pattern: Pattern.Bands,
        patternFreq: rng.range(2, 4),
        iridescence: 0.1,
        finTranslucency: 0.3,
        band: [0.3, 2.5],
        speed: 0.4,
        maxSpeed: 1.5,
        flock: [0.4, 0.4, 1, 1.2],
        turn: 2,
        tailBeat: 1.4,
        wander: 0.7,
        homePull: 0.35,
        home: 'reef',
        homeRadius: 3,
        eye: 0.03,
      });
    } else if (a === 'damsel') {
      list.push({
        name: a,
        count: Math.round(rng.int(70, 110) * k),
        school: rng.int(10, 22),
        spread: 2.2,
        length: [0.12, 0.18],
        bodyType: 0,
        body: body(
          0.36,
          0.1,
          0.6,
          0.15,
          0.24,
          0.5,
          0.1,
          0.07,
          0.08,
          0.25,
          0.8,
          2.1,
        ),
        colors: {
          top: hsv(hue, 0.8, 0.7),
          belly: hsv(hue, 0.5, 0.9),
          accent: hsv(hue, 0.9, 1),
          fin: hsv(hue, 0.7, 0.9),
        },
        pattern: Pattern.Countershade,
        patternFreq: 1,
        iridescence: 0.5,
        finTranslucency: 0.6,
        band: [0.25, 1.8],
        speed: 0.45,
        maxSpeed: 1.6,
        flock: [0.5, 0.6, 1.2, 0.8],
        turn: 3,
        tailBeat: 1.8,
        wander: 0.8,
        homePull: 0.6,
        home: 'reef',
        homeRadius: 2,
        eye: 0.045,
      });
    } else if (a === 'parrot') {
      list.push({
        name: a,
        count: Math.round(rng.int(8, 14) * k),
        school: rng.int(3, 6),
        spread: 1.8,
        length: [0.4, 0.62],
        bodyType: 0,
        body: body(
          0.3,
          0.13,
          0.9,
          0.18,
          0.28,
          0.2,
          0.06,
          0.05,
          0.1,
          0.2,
          0.85,
          2.3,
        ),
        colors: {
          top: hsv(hue * 0.3 + 0.4, 0.7, 0.6),
          belly: hsv(hue * 0.3 + 0.9, 0.5, 0.85),
          accent: hsv(0.9, 0.6, 0.9),
          fin: hsv(0.55, 0.7, 0.7),
        },
        pattern: Pattern.Gradient,
        patternFreq: 1,
        iridescence: 0.35,
        finTranslucency: 0.4,
        band: [0.4, 2.5],
        speed: 0.55,
        maxSpeed: 1.8,
        flock: [0.15, 0.3, 1.5, 3],
        turn: 1.2,
        tailBeat: 1.0,
        wander: 0.6,
        homePull: 0.12,
        home: 'reef',
        homeRadius: 8,
        eye: 0.022,
      });
    } else {
      list.push({
        name: a,
        count: Math.round(rng.int(22, 34) * k),
        school: rng.int(5, 10),
        spread: 1.8,
        length: [0.2, 0.3],
        bodyType: 0,
        body: body(
          0.22,
          0.08,
          0.8,
          0.16,
          0.22,
          0.1,
          0.05,
          0.04,
          0.08,
          0.22,
          0.85,
          2.2,
        ),
        colors: {
          top: hsv(hue, 0.7, 0.7),
          belly: hsv(hue + 0.3, 0.6, 0.9),
          accent: hsv(hue + 0.5, 0.9, 0.95),
          fin: hsv(hue + 0.4, 0.8, 0.9),
        },
        pattern: rng.pick([Pattern.Stripe, Pattern.Spots]),
        patternFreq: rng.range(6, 14),
        iridescence: 0.4,
        finTranslucency: 0.5,
        band: [0.3, 3],
        speed: 0.7,
        maxSpeed: 2,
        flock: [0.2, 0.3, 1, 1.5],
        turn: 2.5,
        tailBeat: 1.3,
        wander: 1,
        homePull: 0.2,
        home: 'reef',
        homeRadius: 5,
        eye: 0.03,
      });
    }
  }

  // Curious hero fish: a few big, colourful fish that come to look at the
  // diver, so there is always readable life within a few metres.
  const heroHue = rng.float();
  list.push({
    name: 'curious',
    count: Math.max(2, Math.round(rng.int(4, 7) * Math.min(1, k))),
    length: [0.38, 0.55],
    bodyType: 0,
    body: body(
      0.32,
      0.1,
      0.7,
      0.16,
      0.34,
      0.25,
      0.14,
      0.1,
      0.12,
      0.2,
      0.85,
      2.1,
    ),
    colors: {
      top: hsv(heroHue, 0.6, 0.5),
      belly: hsv(heroHue + 0.08, 0.35, 0.85),
      accent: hsv(heroHue + 0.12, 0.7, 0.85),
      fin: hsv(heroHue + 0.05, 0.6, 0.75),
    },
    pattern: rng.pick([Pattern.Bands, Pattern.Gradient, Pattern.Stripe]),
    patternFreq: rng.range(3, 6),
    iridescence: 0.5,
    finTranslucency: 0.55,
    band: [0.8, 5],
    speed: 0.45,
    maxSpeed: 1.6,
    flock: [0.05, 0.2, 2.5, 3],
    turn: 1.2,
    tailBeat: 1.1,
    wander: 0.3,
    homePull: 0.03,
    home: 'reef',
    homeRadius: 14,
    eye: 0.025,
    curiosity: 1,
  });

  // Tiny reef fish hovering in little clouds over individual coral heads,
  // darting in and out. Prefer heads near the hero reef, where cameras look.
  const coralHomes = coralHomesFor(ctx);
  if (coralHomes.length) {
    const hoverHues = [rng.range(0.45, 0.55), rng.range(0.0, 0.08)];
    hoverHues.forEach((hue, hi) => {
      list.push({
        name: hi === 0 ? 'chromis' : 'anthias',
        // A little cloud over every coral head.
        count: Math.min(coralHomes.length * 12, Math.round(300 * k)),
        school: 12,
        spread: 1.3,
        length: [0.09, 0.13],
        bodyType: 0,
        body: body(
          0.34,
          0.09,
          0.6,
          0.14,
          0.24,
          0.6,
          0.1,
          0.08,
          0.08,
          0.25,
          0.8,
          2.1,
        ),
        colors: {
          top: hsv(hue, 0.75, 0.75),
          belly: hsv(hue + 0.03, 0.4, 0.95),
          accent: hsv(hue + 0.08, 0.9, 1),
          fin: hsv(hue, 0.6, 0.9),
        },
        pattern: Pattern.Countershade,
        patternFreq: 1,
        iridescence: 0.6,
        finTranslucency: 0.6,
        band: [0.2, 4],
        speed: 0.15,
        maxSpeed: 0.9,
        flock: [0.3, 0.4, 1.4, 0.6],
        turn: 5,
        tailBeat: 2.4,
        wander: 0.5,
        homePull: 2.2,
        home: 'coral',
        homeRadius: 0.5,
        eye: 0.05,
        dart: [14, 2.5],
      });
    });
  }

  // Fish that live among the kelp.
  if (ctx.kelpForests.length) {
    list.push({
      name: 'kelpfish',
      count: Math.round(rng.int(30, 45) * k),
      school: rng.int(4, 9),
      spread: 2,
      length: [0.24, 0.34],
      bodyType: 0,
      body: body(
        0.3,
        0.1,
        0.8,
        0.16,
        0.26,
        0.15,
        0.1,
        0.07,
        0.1,
        0.25,
        0.8,
        2.2,
      ),
      // Bright orange, like Garibaldi: readable against the green-gold kelp.
      colors: {
        top: [1.0, 0.42, 0.06],
        belly: [1.0, 0.55, 0.14],
        accent: [1.0, 0.62, 0.2],
        fin: [1.0, 0.5, 0.1],
      },
      pattern: Pattern.Countershade,
      patternFreq: 1,
      iridescence: 0.2,
      finTranslucency: 0.6,
      band: [0.8, 7],
      speed: 0.5,
      maxSpeed: 1.6,
      flock: [0.15, 0.3, 1.5, 2.5],
      turn: 1.5,
      tailBeat: 1.2,
      wander: 0.7,
      homePull: 0.2,
      home: 'kelp',
      homeRadius: 9,
      eye: 0.03,
    });
  }

  // Large solitary cruisers.
  list.push({
    name: 'grouper',
    count: Math.max(2, Math.round(rng.int(3, 6) * k)),
    length: [0.6, 1.0],
    bodyType: 0,
    body: body(
      0.28,
      0.16,
      1.0,
      0.2,
      0.26,
      0.05,
      0.08,
      0.06,
      0.1,
      0.3,
      0.8,
      2.4,
    ),
    colors: {
      top: hsv(rng.range(0, 0.1), 0.6, 0.45),
      belly: hsv(0.08, 0.35, 0.7),
      accent: hsv(0.05, 0.3, 0.9),
      fin: hsv(0.03, 0.6, 0.45),
    },
    pattern: Pattern.Spots,
    patternFreq: rng.range(10, 18),
    iridescence: 0.05,
    finTranslucency: 0.2,
    band: [0.6, 3.5],
    speed: 0.45,
    maxSpeed: 1.5,
    flock: [0.02, 0.05, 2, 4],
    turn: 0.8,
    tailBeat: 0.8,
    wander: 0.35,
    homePull: 0.04,
    home: 'basin',
    homeRadius: 30,
    eye: 0.02,
  });

  // Clownfish living in the anemones.
  if (ctx.anemones.length) {
    list.push({
      name: 'clown',
      count: ctx.anemones.length * 2,
      school: 2,
      spread: 1,
      length: [0.07, 0.1],
      bodyType: 0,
      body: body(
        0.38,
        0.12,
        0.5,
        0.2,
        0.22,
        0.0,
        0.1,
        0.07,
        0.09,
        0.25,
        0.75,
        2.0,
      ),
      colors: {
        top: [1.0, 0.42, 0.05],
        belly: [1.0, 0.5, 0.1],
        accent: [0.97, 0.97, 0.95],
        fin: [1.0, 0.45, 0.08],
      },
      pattern: Pattern.Clown,
      patternFreq: 1,
      iridescence: 0.1,
      finTranslucency: 0.3,
      band: [0.05, 0.7],
      speed: 0.25,
      maxSpeed: 1.0,
      flock: [0.2, 0.2, 1.5, 0.5],
      turn: 4,
      tailBeat: 2.2,
      wander: 0.6,
      homePull: 2.5,
      home: 'anemone',
      homeRadius: 0.35,
      eye: 0.05,
    });
  }

  // Rays gliding over the sand.
  const manta = rng.bool(0.4);
  list.push({
    name: manta ? 'manta' : 'eagle-ray',
    count: manta
      ? Math.max(1, Math.round(rng.int(1, 2) * k))
      : Math.max(2, Math.round(rng.int(4, 7) * k)),
    // Eagle rays often glide in small groups.
    school: manta ? 1 : rng.int(2, 5),
    spread: 2.5,
    length: manta ? [2.4, 3.2] : [1.0, 1.5],
    bodyType: 1,
    body: [manta ? 1.25 : 1.1, 0.06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    colors: manta
      ? {
          top: [0.08, 0.08, 0.1],
          belly: [0.9, 0.9, 0.88],
          accent: [0.5, 0.5, 0.5],
          fin: [0.1, 0.1, 0.12],
        }
      : {
          top: [0.12, 0.12, 0.16],
          belly: [0.9, 0.9, 0.88],
          accent: [0.85, 0.85, 0.8],
          fin: [0.12, 0.12, 0.15],
        },
    pattern: manta ? Pattern.Countershade : Pattern.Spots,
    patternFreq: 14,
    iridescence: 0,
    finTranslucency: 0.1,
    band: manta ? [3, 8] : [0.8, 4],
    speed: manta ? 1.1 : 0.9,
    maxSpeed: 2,
    flock: [0.05, 0.1, 3, manta ? 0.1 : 6],
    turn: 0.5,
    tailBeat: 0.35,
    wander: 0.25,
    homePull: 0.05,
    home: 'basin',
    homeRadius: 28,
    eye: 0.02,
  });
  return list.filter(s => s.count > 0);
}

// ---------------------------------------------------------------------------
// Mesh

const Part = {
  Body: 0,
  Tail: 1,
  Dorsal: 2,
  Anal: 3,
  PectoralL: 4,
  PectoralR: 5,
  RayTop: 6,
  RayBottom: 7,
  RayTail: 8,
} as const;

const meshWgsl = /* wgsl */ `
${shapes}

fn bodyZ(v: f32) -> f32 {
  return 0.5 - v * 0.8;
}

fn bodyProfile(pat: Patch, v: f32, amount: f32) -> f32 {
  let peak = 0.33;
  if (v < peak) {
    // Tapered snout: never a blunt, lemon-round head.
    return amount * pow(sin(v / peak * 1.5707963), max(pat.p0.z, 0.95));
  }
  let t = smoothstep(peak, 1.0, v);
  // Narrow tail stem (caudal peduncle) before the tail fin.
  return amount * mix(1.0, min(pat.p0.w, 0.13), pow(t, 0.75));
}

/** Body half-height: streamlined, several times longer than tall. */
fn bodyH(pat: Patch, v: f32) -> f32 {
  return bodyProfile(pat, v, pat.p0.x * 0.72);
}

/** Body half-width: a little fuller than the species profile, never a card. */
fn bodyW(pat: Patch, v: f32) -> f32 {
  return bodyProfile(pat, v, max(pat.p0.y * 1.35, pat.p0.x * 0.72 * 0.34));
}

fn fishBody(pat: Patch, uv: vec2f) -> SurfacePoint {
  let v = uv.y;
  let th = uv.x * TAU;
  let h = bodyH(pat, v);
  // Real fish carry more volume than a flat profile suggests; a thicker body
  // keeps them from reading as cards or discs when seen at an angle.
  let w = bodyW(pat, v);
  let e = 2.0 / pat.p2.w;
  let c = cos(th);
  let s = sin(th);
  // Belly slightly fuller than the back.
  let belly = select(1.0, 1.12, s < 0.0);
  let p = vec3f(w * sign(c) * pow(abs(c), e), h * belly * sign(s) * pow(abs(s), e), bodyZ(v));
  var o = sp(p, vec4f(uv.x, v, v, ${Part.Body}));
  o.ao = mix(0.55, 1.0, smoothstep(-0.8, 0.6, s));
  return o;
}

fn fishTail(pat: Patch, uv: vec2f) -> SurfacePoint {
  let yy = uv.x * 2.0 - 1.0;
  let ped = bodyH(pat, 1.0);
  let span = mix(ped, pat.p1.x, pow(uv.y, 0.7));
  let fork = pat.p1.y * (1.0 - abs(yy));
  let len = 0.2 * (1.0 - fork * uv.y * 0.8) + 0.02 * abs(yy);
  let p = vec3f(0.0, yy * span, bodyZ(1.0) - uv.y * len);
  return sp(p, vec4f(uv.x, uv.y, 1.0 + uv.y * 0.25, ${Part.Tail}));
}

fn fishFin(pat: Patch, uv: vec2f, bottom: bool) -> SurfacePoint {
  var bv: f32;
  var height: f32;
  var shape: f32;
  if (bottom) {
    bv = mix(0.55, 0.88, uv.x);
    height = pat.p1.w;
    shape = pow(sin(uv.x * 3.14159), 0.8);
  } else {
    bv = mix(pat.p2.y, pat.p2.z, uv.x);
    height = pat.p1.z;
    shape = pow(sin(uv.x * 3.14159), 0.6) * (1.0 - uv.x * 0.35);
  }
  let base = bodyH(pat, bv) * 0.9;
  let dirY = select(1.0, -1.0, bottom);
  let y = dirY * (base + uv.y * height * shape);
  let p = vec3f(0.0, y, bodyZ(bv) - uv.y * shape * height * 0.4);
  let part = select(${Part.Dorsal}, ${Part.Anal}, bottom);
  return sp(p, vec4f(uv, bv, f32(part)));
}

fn fishPectoral(pat: Patch, uv: vec2f, side: f32) -> SurfacePoint {
  let bv = 0.26;
  let root = vec3f(side * bodyW(pat, bv) * 0.85, -bodyH(pat, bv) * 0.3, bodyZ(bv));
  let size = pat.p2.x;
  let chord = size * (1.0 - uv.y * 0.55);
  let p = root + vec3f(side * uv.y * size * 0.7, -uv.y * size * 0.25, -uv.x * chord - uv.y * size * 0.45);
  let part = select(${Part.PectoralL}, ${Part.PectoralR}, side > 0.0);
  return sp(p, vec4f(uv, bv, f32(part)));
}

fn raySpan(pat: Patch, v: f32) -> f32 {
  let peak = 0.38;
  if (v < peak) {
    return pat.p0.x * 0.5 * pow(sin(v / peak * 1.5707963), 0.8);
  }
  return pat.p0.x * 0.5 * pow(1.0 - (v - peak) / (1.0 - peak), 1.3);
}

fn rayBody(pat: Patch, uv: vec2f, top: bool) -> SurfacePoint {
  let xx = uv.x * 2.0 - 1.0;
  let v = uv.y;
  let span = raySpan(pat, v);
  // Wing tips sweep back.
  let sweep = pow(abs(xx), 2.0) * 0.18;
  let thick = pat.p0.y * pow(max(1.0 - xx * xx, 0.0), 1.5) * (1.0 - v * 0.5) * smoothstep(0.0, 0.08, v);
  let s = select(-0.4, 1.0, top);
  let p = vec3f(xx * span, thick * s, 0.5 - v - sweep * smoothstep(0.1, 0.6, v));
  let part = select(${Part.RayBottom}, ${Part.RayTop}, top);
  return sp(p, vec4f(uv.x, v, v, f32(part)));
}

fn rayTail(uv: vec2f) -> SurfacePoint {
  let a = uv.x * TAU;
  let r = 0.012 * (1.0 - uv.y * 0.9);
  let z = -0.45 - uv.y * 0.9;
  let p = vec3f(cos(a) * r, sin(a) * r + 0.01, z);
  var o = sp(p, vec4f(uv.x, uv.y, 1.0 + uv.y, ${Part.RayTail}));
  o.normal = vec3f(cos(a), sin(a), 0.0);
  return o;
}

fn surface(pat: Patch, uv: vec2f) -> SurfacePoint {
  switch (u32(pat.p3.z)) {
    case ${Part.Tail}u: { return fishTail(pat, uv); }
    case ${Part.Dorsal}u: { return fishFin(pat, uv, false); }
    case ${Part.Anal}u: { return fishFin(pat, uv, true); }
    case ${Part.PectoralL}u: { return fishPectoral(pat, uv, -1.0); }
    case ${Part.PectoralR}u: { return fishPectoral(pat, uv, 1.0); }
    case ${Part.RayTop}u: { return rayBody(pat, uv, true); }
    case ${Part.RayBottom}u: { return rayBody(pat, uv, false); }
    case ${Part.RayTail}u: { return rayTail(uv); }
    default: { return fishBody(pat, uv); }
  }
}
`;

/** Detail levels per species: full, reduced, and a tiny far-away stand-in. */
const LODS = 3;

function speciesPatches(s: SpeciesDef, level: number, hi: boolean): Patch[] {
  const p = (part: number, segU: number, segV: number): Patch => {
    const params = new Array(16).fill(0);
    s.body.forEach((v, i) => (params[i] = v));
    params[12] = s.bodyType;
    params[14] = part;
    return {segU, segV, params};
  };
  const q = (full: number, mid: number, tiny: number) =>
    level === 0 ? full : level === 1 ? mid : tiny;
  if (s.bodyType === 1) {
    return [
      p(Part.RayTop, q(hi ? 40 : 20, 14, 6), q(hi ? 24 : 12, 8, 3)),
      p(Part.RayBottom, q(hi ? 40 : 20, 14, 6), q(hi ? 24 : 12, 8, 3)),
      p(Part.RayTail, q(4, 3, 2), q(8, 4, 2)),
    ];
  }
  return [
    p(Part.Body, q(hi ? 28 : 14, 12, 6), q(hi ? 36 : 16, 12, 5)),
    p(Part.Tail, q(6, 3, 2), q(6, 3, 1)),
    p(Part.Dorsal, q(10, 5, 3), q(3, 2, 1)),
    p(Part.Anal, q(6, 3, 2), q(3, 1, 1)),
    p(Part.PectoralL, q(3, 2, 1), q(3, 2, 1)),
    p(Part.PectoralR, q(3, 2, 1), q(3, 2, 1)),
  ];
}

/** Triangle-index count of the body part (the rest are fins) of a patch list. */
function bodyIndices(s: SpeciesDef, patches: Patch[]): number {
  const body = s.bodyType === 1 ? patches : patches.slice(0, 1);
  return body.reduce((n, p) => n + p.segU * p.segV * 6, 0);
}

// ---------------------------------------------------------------------------
// Simulation

const hashWgsl = /* wgsl */ `
fn hashU(n: u32) -> f32 {
  var h = n * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) / 4294967295.0;
}
`;

const simWgsl = /* wgsl */ `
${hashWgsl}
${SpeciesStruct.wgsl}
${FishStruct.wgsl}
${FishInstanceStruct.wgsl}
${SimStruct.wgsl}

@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> fishIn: array<Fish>;
@group(0) @binding(2) var<storage, read_write> fishOut: array<Fish>;
@group(0) @binding(3) var<storage, read> species: array<Species>;
@group(0) @binding(4) var<storage, read_write> instances: array<FishInstance>;
@group(0) @binding(5) var<storage, read> obstacles: array<vec4f>;
@group(0) @binding(6) var tTerrain: texture_2d<f32>;
@group(0) @binding(7) var sClamp: sampler;

fn groundAt(xz: vec2f) -> f32 {
  return textureSampleLevel(tTerrain, sClamp, xz / sim.worldSize + 0.5, 0.0).r;
}

/**
 * Which way the ground falls away here, and how steeply.
 *
 * The terrain's surface normal is stored alongside its height, and its
 * horizontal part points down the slope — so it is exactly the direction to
 * swim to get away from a wall, and its length says how much of a wall this is.
 */
fn groundSlope(xz: vec2f) -> vec3f {
  let t = textureSampleLevel(tTerrain, sClamp, xz / sim.worldSize + 0.5, 0.0);
  return vec3f(t.g, 0.0, t.b);
}

fn quatFromBasis(x: vec3f, y: vec3f, z: vec3f) -> vec4f {
  let trace = x.x + y.y + z.z;
  if (trace > 0.0) {
    let s = 0.5 / sqrt(trace + 1.0);
    return vec4f((y.z - z.y) * s, (z.x - x.z) * s, (x.y - y.x) * s, 0.25 / s);
  }
  if (x.x > y.y && x.x > z.z) {
    let s = 2.0 * sqrt(1.0 + x.x - y.y - z.z);
    return vec4f(0.25 * s, (x.y + y.x) / s, (z.x + x.z) / s, (y.z - z.y) / s);
  }
  if (y.y > z.z) {
    let s = 2.0 * sqrt(1.0 + y.y - x.x - z.z);
    return vec4f((x.y + y.x) / s, 0.25 * s, (y.z + z.y) / s, (z.x - x.z) / s);
  }
  let s = 2.0 * sqrt(1.0 + z.z - x.x - y.y);
  return vec4f((z.x + x.z) / s, (y.z + z.y) / s, 0.25 * s, (x.y - y.x) / s);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= sim.count) {
    return;
  }
  var f = fishIn[i];
  let sp = species[u32(f.species)];
  let dt = sim.dt;
  let len = sp.motion.y;
  let fi = f32(i);
  let leaderIndex = u32(f.leader.x);
  let isLeader = leaderIndex == i;

  var acc = vec3f(0.0);
  var maxSpeed = sp.band.w;
  if (isLeader) {
    // Stay near home (which, for roaming schools, travels a slow wobbly loop).
    let roam = sp.behavior.z;
    let roamA = sim.time * sp.behavior.w + fi * 0.37;
    let roamOff = vec3f(cos(roamA), 0.12 * sin(roamA * 2.0), sin(roamA) * 0.7) * roam;
    let toHome = f.home.xyz + roamOff - f.pos;
    let hd = length(toHome);
    if (hd > f.home.w) {
      acc += toHome / hd * (hd - f.home.w) * sp.extra.y;
    }
    // Wander.
    acc += vec3f(
      sin(sim.time * 0.37 + fi * 1.7) + sin(sim.time * 0.13 + fi * 0.3),
      sin(sim.time * 0.29 + fi * 2.3) * 0.25,
      cos(sim.time * 0.41 + fi * 0.9) + cos(sim.time * 0.11 + fi * 1.1),
    ) * sp.extra.x;
    // Cruise speed.
    let speed = length(f.vel);
    let dir = select(vec3f(0.0, 0.0, 1.0), f.vel / speed, speed > 1e-4);
    acc += dir * (sp.band.z - speed) * 0.8;
  } else {
    // Follower: hold a slot in the leader's formation. The slot is fixed per
    // fish (hashed), laid out in the leader's heading frame, and drifts a
    // little so the school breathes.
    let L = fishIn[leaderIndex];
    let lv = vec3f(L.vel.x, L.vel.y * 0.3, L.vel.z);
    let lf = normalize(lv + vec3f(1e-4, 0.0, 0.0));
    let lr = normalize(cross(vec3f(0.0, 1.0, 0.0), lf) + vec3f(1e-5, 0.0, 0.0));
    let lu = cross(lf, lr);
    var slot = vec3f(hashU(i * 3u), hashU(i * 3u + 1u), hashU(i * 3u + 2u)) * 2.0 - 1.0;
    slot = slot / max(length(slot), 1e-3) * pow(hashU(i * 7u + 5u), 0.4);
    let drift = sp.school.w;
    slot += vec3f(
      sin(sim.time * 0.31 + fi * 1.7),
      sin(sim.time * 0.23 + fi * 2.3) * 0.5,
      cos(sim.time * 0.27 + fi * 0.9),
    ) * drift * 0.35;
    let radius = sp.school.x;
    let local = vec3f(slot.x * radius, slot.y * radius * 0.5, slot.z * radius * sp.school.y);
    let slotPos = L.pos + lr * local.x + lu * local.y + lf * local.z;
    let k = sp.school.z;
    let toTarget = slotPos - f.pos;
    acc += toTarget * k + (L.vel - f.vel) * k * 0.9;
    // Far behind (after scattering from the camera): allowed to hurry back.
    maxSpeed = sp.band.w * mix(1.2, 2.5, smoothstep(1.0, 6.0, length(toTarget)));
    // A touch of individual wander so neighbours don't move in lockstep.
    acc += vec3f(sin(sim.time * 1.1 + fi * 3.1), sin(sim.time * 0.9 + fi * 1.3) * 0.3, cos(sim.time * 1.3 + fi * 2.1)) * sp.extra.x * 0.3;
  }

  // Height band above the ground, below the ceiling; look ahead for rising ground.
  let g = groundAt(f.pos.xz);
  let minY = g + sp.band.x;
  let maxY = min(g + sp.band.y, sim.ceiling);
  acc.y += (max(minY - f.pos.y, 0.0) - max(f.pos.y - maxY, 0.0)) * 3.0;
  let ahead = f.pos + f.vel * 1.5;
  let ga = groundAt(ahead.xz);
  if (ahead.y < ga + sp.band.x) {
    acc.y += (ga + sp.band.x - ahead.y) * 5.0;
    // A wall is not something to climb over: on ground steep enough that
    // rising would not clear it in time, swim along it instead, turning down
    // the slope. Gentle ground still just gets swum over as before.
    let slope = groundSlope(ahead.xz);
    let steep = length(slope);
    if (steep > 0.35) {
      let close = clamp((ga + sp.band.x - ahead.y) / max(sp.band.x, 0.5), 0.0, 1.0);
      acc += normalize(slope + vec3f(1e-5, 0.0, 0.0)) * steep * close * 9.0;
    }
  }

  // Rocks.
  for (var k = 0u; k < sim.obstacleCount; k++) {
    let ob = obstacles[k];
    let d = f.pos - ob.xyz;
    let dist = length(d) + 1e-4;
    let r = ob.w + len + 0.2;
    if (dist < r * 1.4) {
      acc += d / dist * (r * 1.4 - dist) * 6.0;
    }
  }

  // Shy of the camera, unless curious: curious fish drift in to look at the
  // diver, holding a few metres in front of the lens.
  let dc = f.pos - sim.camPos;
  let cd = length(dc) + 1e-4;
  let fear = sp.behavior.y;
  if (cd < fear) {
    acc += dc / cd * (fear - cd) * 5.0;
  }
  let curious = sp.behavior.x;
  if (curious > 0.0 && cd < 18.0) {
    // Each curious fish holds its own spot so they don't pile up on one point.
    let side = sin(sim.time * 0.15 + fi * 2.1) * 1.0 + (fract(fi * 0.618) - 0.5) * 4.0;
    let right = normalize(cross(sim.camDir, vec3f(0.0, 1.0, 0.0)) + vec3f(1e-4));
    // Far enough to stay inside the focus range (closer, they fill the lens as blurry shapes).
    let spot = sim.camPos + sim.camDir * (4.0 + fract(fi * 0.37) * 3.0) + right * side;
    acc += (spot - f.pos) * curious * 1.4 * smoothstep(22.0, 6.0, cd);
  }

  // Darting: every few seconds a fish bolts a short way, then settles.
  if (sp.dart.x > 0.0) {
    let tt = sim.time / sp.dart.y + fract(fi * 0.6180339);
    let cycle = floor(tt);
    let ph = fract(tt);
    let r1 = fract(sin(fi * 12.9898 + cycle * 78.233) * 43758.5453);
    let r2 = fract(r1 * 91.7 + 0.31);
    let r3 = fract(r2 * 57.3 + 0.77);
    if (ph < 0.1 && r1 < 0.55) {
      let d = normalize(vec3f(r2 - 0.5, (r3 - 0.5) * 0.35, fract(r3 * 13.1) - 0.5) + vec3f(1e-4));
      acc += d * sp.dart.x * (1.0 - ph / 0.1);
      maxSpeed = max(maxSpeed, sp.band.w * 3.0);
    }
  }

  var vel = f.vel + acc * dt * sp.motion.x;
  let speed = clamp(length(vel), sp.band.z * 0.3, maxSpeed);
  vel = normalize(vel + vec3f(1e-5, 0.0, 0.0)) * speed;
  // Fish rarely pitch steeply.
  vel.y = clamp(vel.y, -0.45 * speed, 0.45 * speed);
  f.vel = vel;
  f.pos += vel * dt;
  f.phase += dt * (speed / max(len, 0.05) * sp.motion.w * 0.5 + 0.6);
  fishOut[i] = f;

  let prev = instances[i];
  var o: FishInstance;
  let scale = len * (0.85 + 0.3 * fract(fi * 0.618));
  let fwd = normalize(vel);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), fwd) + vec3f(1e-5));
  let up = cross(fwd, right);
  let bank = clamp(dot(acc, right) * 0.08, -0.6, 0.6) * select(1.0, 0.3, sp.motion.z > 0.5);
  let r2 = right * cos(bank) + up * sin(bank);
  let u2 = cross(fwd, r2);
  o.posScale = vec4f(f.pos, scale);
  o.rot = normalize(quatFromBasis(r2, u2, fwd));
  let fresh = prev.posScale.w == 0.0;
  o.prevPosScale = select(prev.posScale, o.posScale, fresh);
  o.prevRot = select(prev.rot, o.rot, fresh);
  o.anim = vec4f(f.phase, select(prev.anim.x, f.phase, fresh), speed / sp.band.w, f.species);
  o.tint = vec4f(0.9 + 0.2 * fract(fi * 0.371), 0.9 + 0.2 * fract(fi * 0.529), 0.9 + 0.2 * fract(fi * 0.817), 0.0);
  instances[i] = o;
}
`;

const CullStruct = defineStruct('Cull', {
  viewProj: 'mat4x4f',
  /** Left/right/bottom/top frustum planes, normalized (see render/frustum). */
  planes: 'mat4x4f',
  camPos: 'vec3f',
  focalPx: 'f32',
  maxDist: 'f32',
  count: 'u32',
  /** Projected radius in pixels above which the full / reduced mesh is used. */
  lod0Px: 'f32',
  lod1Px: 'f32',
});

/** View culling and detail selection for every fish, sorted into buckets. */
const cullWgsl = /* wgsl */ `
${FishInstanceStruct.wgsl}
${CullStruct.wgsl}
const LODS = ${LODS}u;
@group(0) @binding(0) var<uniform> P: Cull;
@group(0) @binding(1) var<storage, read> instances: array<FishInstance>;
/** Per species: first fish index, fish count. */
@group(0) @binding(2) var<storage, read> ranges: array<vec2u>;
@group(0) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> visible: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.count) {
    return;
  }
  let inst = instances[i];
  let pos = inst.posScale.xyz;
  let r = max(inst.posScale.w * 0.7, 0.05);
  let d = distance(pos, P.camPos);
  if (inst.posScale.w <= 0.0 || d > P.maxDist + r) {
    return;
  }
  // Distance to each side plane, in world units (so one radius of slack means
  // the same on every side whatever the shape of the window).
  let side = vec4f(pos, 1.0) * P.planes;
  let c = P.viewProj * vec4f(pos, 1.0);
  if (c.w < -r || any(side < vec4f(-r))) {
    return;
  }
  let px = r * P.focalPx / max(d, 0.1);
  let lod = select(select(2u, 1u, px > P.lod1Px), 0u, px > P.lod0Px);
  let s = u32(inst.anim.w);
  let slot = atomicAdd(&counts[s * LODS + lod], 1u);
  visible[ranges[s].x * LODS + lod * ranges[s].y + slot] = i;
}
`;

/** Copies the bucket counts into the instance counts of the indirect draws. */
const indirectWgsl = /* wgsl */ `
@group(0) @binding(0) var<storage, read> counts: array<u32>;
@group(0) @binding(1) var<storage, read_write> args: array<u32>;

@compute @workgroup_size(16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let b = id.x;
  if (b >= arrayLength(&counts)) {
    return;
  }
  // Two indexed-indirect draws per bucket (body, then fins), 5 u32 each.
  args[b * 10u + 1u] = counts[b];
  args[b * 10u + 6u] = counts[b];
}
`;

// ---------------------------------------------------------------------------
// Rendering

/**
 * Fish render shader. Bodies are drawn with `discard` compiled out: a pipeline
 * that can discard defeats hidden-surface removal on tile-based GPUs, and a
 * big school overlapping itself then costs several times the frame budget.
 */
const renderWgslFor = (allowDiscard: boolean) => {
  const discard = allowDiscard ? 'discard;' : '';
  return /* wgsl */ `
${surfaceLib}
${propsWgsl}
${SpeciesStruct.wgsl}
${FishInstanceStruct.wgsl}
@group(1) @binding(0) var<storage, read> instances: array<FishInstance>;
@group(1) @binding(1) var<storage, read> species: array<Species>;
@group(1) @binding(2) var<storage, read> visible: array<u32>;
struct DrawInfo {
  /** Start of this draw's run of fish indices (or first fish, if direct). */
  base: u32,
  /** 1: instance index + base is the fish index (no visibility list). */
  direct: u32,
};
@group(1) @binding(3) var<uniform> drawInfo: DrawInfo;

fn fishIndex(instance: u32) -> u32 {
  return select(visible[drawInfo.base + instance], drawInfo.base + instance, drawInfo.direct == 1u);
}

fn quatRotate(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

struct VIn {
  @location(0) position: vec4f,
  @location(1) normal: vec4f,
  @location(2) uv: vec4f,
  @builtin(instance_index) instance: u32,
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec4f,
  @location(3) local: vec3f,
  @location(4) @interpolate(flat) instance: u32,
  @location(5) ao: f32,
  @location(6) curClip: vec4f,
  @location(7) prevClip: vec4f,
};

fn swim(p: vec3f, uv: vec4f, phase: f32, speedNorm: f32, sp: Species) -> vec3f {
  let part = u32(uv.w + 0.5);
  let bodyV = uv.z;
  var q = p;
  if (sp.motion.z > 0.5) {
    // Rays flap their wings in a wave travelling back along the body.
    let span = abs(p.x) / 0.6;
    q.y += sin(phase * 6.2831853 - bodyV * 2.2) * pow(span, 1.6) * 0.16;
    q.x *= 1.0 - pow(span, 2.0) * 0.08 * (0.5 + 0.5 * sin(phase * 6.2831853 - bodyV * 2.2));
    if (part == ${Part.RayTail}u) {
      q.x += sin(phase * 3.0 - bodyV * 4.0) * (bodyV - 1.0) * 0.06;
    }
    return q;
  }
  // Travelling body wave; amplitude grows toward the tail.
  let k = 6.2831853 * 0.9;
  let amp = (0.02 + 0.1 * bodyV * bodyV) * (0.55 + 0.45 * speedNorm);
  q.x += amp * sin(bodyV * k - phase * 6.2831853);
  if (part == ${Part.PectoralL}u || part == ${Part.PectoralR}u) {
    // Pectoral fins row gently.
    let flap = sin(phase * 3.14159 + select(0.0, 3.14159, part == ${Part.PectoralR}u)) * 0.5 + 0.3;
    q.x += sign(p.x) * uv.y * 0.02 * flap;
    q.z -= uv.y * 0.02 * flap;
  }
  if (part == ${Part.Dorsal}u || part == ${Part.Anal}u) {
    q.x += sin(phase * 6.2831853 * 0.7 - uv.x * 4.0) * uv.y * 0.01;
  }
  return q;
}

@vertex
fn vs(v: VIn) -> VOut {
  let fish = fishIndex(v.instance);
  let inst = instances[fish];
  let sp = species[u32(inst.anim.w)];
  let local = swim(v.position.xyz, v.uv, inst.anim.x, inst.anim.z, sp);
  let prevLocal = swim(v.position.xyz, v.uv, inst.anim.y, inst.anim.z, sp);
  let world = quatRotate(inst.rot, local * inst.posScale.w) + inst.posScale.xyz;
  let prevWorld = quatRotate(inst.prevRot, prevLocal * inst.prevPosScale.w) + inst.prevPosScale.xyz;
  var o: VOut;
  o.pos = frame.viewProj * vec4f(world, 1.0);
  o.world = world;
  o.normal = quatRotate(inst.rot, v.normal.xyz);
  o.uv = v.uv;
  o.local = v.position.xyz;
  o.instance = fish;
  o.ao = v.position.w;
  o.curClip = frame.viewProjNoJitter * vec4f(world, 1.0);
  o.prevClip = frame.prevViewProjNoJitter * vec4f(prevWorld, 1.0);
  return o;
}

@vertex
fn vsShadow(v: VIn) -> @builtin(position) vec4f {
  let inst = instances[fishIndex(v.instance)];
  let sp = species[u32(inst.anim.w)];
  let local = swim(v.position.xyz, v.uv, inst.anim.x, inst.anim.z, sp);
  let world = quatRotate(inst.rot, local * inst.posScale.w) + inst.posScale.xyz;
  return frame.shadowViewProj * vec4f(world, 1.0);
}

fn fishPattern(sp: Species, i: VOut, n: vec3f) -> vec3f {
  let u = i.uv.x;
  let v = i.uv.y;
  let sideUp = sin(u * 6.2831853);
  var c = mix(sp.colBelly.rgb, sp.colTop.rgb, smoothstep(-0.35, 0.45, sideUp));
  let kind = u32(sp.colTop.w + 0.5);
  let freq = sp.colBelly.w;
  switch (kind) {
    case ${Pattern.Bands}u: {
      let b = smoothstep(0.35, 0.45, abs(fract(v * freq + 0.3) - 0.5));
      c = mix(c, sp.colAccent.rgb, (1.0 - b) * smoothstep(0.1, 0.25, v));
    }
    case ${Pattern.Stripe}u: {
      let stripe = smoothstep(0.18, 0.05, abs(sideUp - 0.12));
      c = mix(c, sp.colAccent.rgb, stripe * 0.8);
    }
    case ${Pattern.Spots}u: {
      let w = worley2p(vec2f(v * freq, u * freq * 2.0), vec2i(0)).x;
      c = mix(c, sp.colAccent.rgb, smoothstep(0.35, 0.2, w) * 0.8);
    }
    case ${Pattern.Gradient}u: {
      c = mix(c, sp.colAccent.rgb, smoothstep(0.2, 0.9, v) * 0.7);
    }
    case ${Pattern.Clown}u: {
      var band = 0.0;
      var centers = array<f32, 3>(0.22, 0.52, 0.86);
      for (var k = 0; k < 3; k++) {
        let center = centers[k];
        let d = abs(v - center);
        band = max(band, smoothstep(0.06, 0.04, d));
        // Thin black edge.
        c = mix(c, vec3f(0.02), smoothstep(0.075, 0.06, d) * (1.0 - smoothstep(0.06, 0.05, d)));
      }
      c = mix(c, sp.colAccent.rgb, band);
    }
    default: {}
  }
  return c;
}

struct FOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
};

@fragment
fn fs(i: VOut, @builtin(front_facing) front: bool) -> FOut {
  var n = normalize(i.normal);
  if (!front) {
    n = -n;
  }
  let inst = instances[i.instance];
  let sp = species[u32(inst.anim.w)];
  let part = u32(i.uv.w + 0.5);
  let V = normalize(frame.camPos - i.world);
  // Fish right in front of the lens dissolve instead of filling the frame
  // with a blurry blob.
  let camDist = length(frame.camPos - i.world);
  if (ign(i.pos.xy, frame.frameIndex * 5u + i.instance) > smoothstep(0.35, 1.1, camDist)) {
    ${discard}
  }
  var s = defaultSurface();
  s.normal = n;
  s.ao = i.ao;
  s.f0 = 0.04;

  let isRay = sp.motion.z > 0.5;
  if (part == ${Part.Body}u || part == ${Part.RayTop}u || part == ${Part.RayBottom}u) {
    var c = fishPattern(sp, i, n) * inst.tint.rgb;
    if (isRay) {
      let top = part == ${Part.RayTop}u;
      c = select(sp.colBelly.rgb, sp.colTop.rgb, top);
      if (top && u32(sp.colTop.w + 0.5) == ${Pattern.Spots}u) {
        let w = worley2p(i.local.xz * 14.0, vec2i(0)).x;
        c = mix(c, sp.colAccent.rgb, smoothstep(0.3, 0.15, w));
      }
    }
    // Scales: overlapping rows (offset every other row) that catch the light,
    // a darker lateral line, and a subtle mottling so colour isn't flat.
    let row = floor(i.uv.y * 55.0);
    let scaleUv = vec2f(i.uv.y * 55.0, i.uv.x * 38.0 + row * 0.5);
    let cell = fract(scaleUv);
    let scaleEdge = smoothstep(0.55, 0.95, length(cell - vec2f(0.2, 0.5)));
    let lateral = smoothstep(0.035, 0.0, abs(sin(i.uv.x * 6.2831853) - 0.08)) * smoothstep(0.12, 0.3, i.uv.y);
    let mottle = fbm2(vec2f(i.uv.y * 9.0, i.uv.x * 14.0), 3);
    let rim = pow(1.0 - max(dot(n, V), 0.0), 2.0);
    let irid = palette(dot(n, V) * 1.3 + i.uv.y, vec3f(0.5), vec3f(0.5), vec3f(1.0), vec3f(0.0, 0.33, 0.67));
    // Backs are darker and less saturated than the pattern suggests, as on real fish.
    let back = smoothstep(0.3, 0.9, sin(i.uv.x * 6.2831853));
    c = mix(c, c * vec3f(0.3, 0.36, 0.42), back * 0.85);
    // Pale belly.
    let belly = smoothstep(-0.2, -0.85, sin(i.uv.x * 6.2831853));
    c = mix(c, mix(c, vec3f(0.85, 0.85, 0.8), 0.55), belly);
    s.albedo = c * (0.9 + 0.12 * mottle) * mix(1.0, 0.8, scaleEdge) * mix(1.0, 0.7, lateral);
    // Guanine platelets: a colour-shifting sheen that follows the viewing
    // angle, strongest on flanks lit from above.
    let flank = smoothstep(-0.3, 0.6, n.y + 0.3);
    s.emissive = irid * (rim * 0.6 + 0.1) * sp.colAccent.w * flank * 0.008 * sunAtDepth(i.world.y);
    // Satin, not lacquer: broad soft highlights with scale sparkle on top.
    s.roughness = mix(0.55, 0.22, sp.colAccent.w);
    // Silvery flanks mirror the water; the dark back stays matte, so a school
    // seen from above reads as dark bodies rather than glassy grey shapes.
    s.f0 = mix(0.04, 0.09, sp.colAccent.w) * mix(1.0, 0.4, back);
    s.roughness = mix(s.roughness, 0.6, back);
    // Each scale is tilted a little differently, so highlights flash across
    // the body as the fish turns (strongest on silvery species).
    let cellId = floor(scaleUv);
    let h1 = fract(sin(dot(cellId, vec2f(12.9898, 78.233))) * 43758.5453);
    let h2 = fract(h1 * 17.13 + 0.37);
    let tilt = vec3f(h1 - 0.5, h2 - 0.5, (h1 + h2) * 0.5 - 0.5) * (0.25 + 0.6 * sp.colAccent.w);
    s.normal = normalize(bumpNormal(n, vec3f(0.0, scaleEdge - 0.5, 0.0) * 0.04) + tilt * 0.5);
    // Face: gill cover edge behind the eye, darker snout and mouth line, then the eye.
    if (!isRay) {
      let gill = smoothstep(0.012, 0.0, abs(i.uv.y - 0.2 - sin(i.uv.x * 6.2831853) * 0.015)) * smoothstep(0.9, 0.3, abs(sin(i.uv.x * 6.2831853)));
      s.albedo *= 1.0 - gill * 0.45;
      let snout = smoothstep(0.08, 0.0, i.uv.y);
      s.albedo *= 1.0 - snout * 0.35;
      let mouth = smoothstep(0.01, 0.0, abs(i.local.y + 0.01)) * smoothstep(0.06, 0.0, i.uv.y);
      s.albedo *= 1.0 - mouth * 0.7;
      let eyeZ = 0.5 - 0.1;
      let d = length(vec2f(i.local.z - eyeZ, i.local.y - sp.extra.z));
      // Only on the flanks: the (z, y) disc would otherwise band over the
      // top of the head and read as a glowing snout from above.
      let flankOnly = smoothstep(0.45, 0.75, abs(cos(i.uv.x * 6.2831853)));
      let eye = smoothstep(sp.extra.w, sp.extra.w * 0.8, d) * flankOnly;
      let pupil = smoothstep(sp.extra.w * 0.6, sp.extra.w * 0.45, d) * smoothstep(0.45, 0.75, abs(cos(i.uv.x * 6.2831853)));
      // A dark socket ring, a gold iris and a large black pupil with a catch
      // light: the eye is what makes a fish read as an animal.
      let socket = smoothstep(sp.extra.w * 1.45, sp.extra.w * 1.05, d) * flankOnly;
      s.albedo *= 1.0 - socket * 0.45;
      // Iris: gold on big fish, silvery on small ones.
      s.albedo = mix(s.albedo, mix(vec3f(0.45, 0.47, 0.5), vec3f(0.8, 0.68, 0.28), smoothstep(0.25, 0.45, sp.motion.y)), eye);
      s.albedo = mix(s.albedo, vec3f(0.005), pupil);
      s.roughness = mix(s.roughness, 0.05, eye);
    }
  } else {
    // Fins: a thin membrane stretched between bony rays. The membrane is
    // genuinely see-through: stochastic (dithered) transparency that TAA
    // resolves into a soft, partially transparent fin; the rays stay denser.
    let rayLine = smoothstep(0.7, 0.97, sin(i.uv.x * 48.0) * 0.5 + 0.5);
    let edgeFade = 1.0 - smoothstep(0.7, 1.0, i.uv.y) * 0.6;
    let opacity = mix(0.3 + 0.35 * (1.0 - sp.colFin.w), 0.95, rayLine) * edgeFade;
    if (ign(i.pos.xy, frame.frameIndex * 7u + i.instance) > opacity) {
      ${discard}
    }
    // Fins carry a little of the body colour and glow only softly when backlit.
    s.albedo = mix(sp.colFin.rgb, sp.colTop.rgb, 0.3) * mix(0.85, 1.0, rayLine) * inst.tint.rgb;
    s.translucency = max(sp.colFin.w, 0.6) * 0.55;
    s.roughness = 0.45;
    if (part == ${Part.Tail}u && u32(sp.colTop.w + 0.5) == ${Pattern.Clown}u) {
      s.albedo = mix(s.albedo, vec3f(0.02), smoothstep(0.8, 0.95, i.uv.y));
    }
  }

  let lit = shadeSurface(s, i.world, -1.0);
  var o: FOut;
  o.color = vec4f(applyWater(lit, i.world), 1.0);
  o.velocity = (i.curClip.xy / i.curClip.w - i.prevClip.xy / i.prevClip.w) * vec2f(0.5, -0.5);
  return o;
}
`;
};
// Soft contact shadows: a blurred dark blob on the ground under each fish
// swimming close to the bottom, offset along the sun and fading with height.
// (The shadow map only has the bigger fish, and too few texels for these.)
const blobShadowWgsl = /* wgsl */ `
${surfaceLib}
${FishInstanceStruct.wgsl}
@group(1) @binding(0) var<storage, read> instances: array<FishInstance>;

struct BOut {
  @builtin(position) pos: vec4f,
  @location(0) quad: vec2f,
  @location(1) strength: f32,
};

fn quatRotate(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BOut {
  let inst = instances[ii];
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let c = corners[vi];
  var o: BOut;
  let fishPos = inst.posScale.xyz;
  let len = inst.posScale.w;
  let uv = fishPos.xz / frame.terrain.x + 0.5;
  let ground = textureSampleLevel(tTerrain, sLinearClamp, uv, 0.0).r;
  let h = fishPos.y - ground;
  // Bigger fish throw a darker shadow, and from higher up.
  let size = clamp(len * 2.5, 0.35, 1.0);
  let fade = (1.0 - smoothstep(0.3, 2.5 + size * 2.5, h)) * smoothstep(-0.1, 0.05, h) * size;
  if (fade <= 0.0 || len <= 0.0) {
    o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
    return o;
  }
  // Blob elongated along the fish, growing softer and larger with height.
  let fwd3 = quatRotate(inst.rot, vec3f(0.0, 0.0, 1.0));
  let fwd = normalize(vec2f(fwd3.x, fwd3.z) + vec2f(1e-4, 0.0));
  let side = vec2f(-fwd.y, fwd.x);
  let spread = 1.0 + h * 0.8;
  let halfLen = len * 0.55 * spread + 0.05;
  let halfWid = len * 0.22 * spread + 0.05;
  let offset = -frame.sunDir.xz / max(frame.sunDir.y, 0.3) * h;
  let xz = fishPos.xz + offset + fwd * c.y * halfLen + side * c.x * halfWid;
  let gy = textureSampleLevel(tTerrain, sLinearClamp, xz / frame.terrain.x + 0.5, 0.0).r;
  // Pulled a little toward the camera so it isn't hidden by the terrain mesh
  // (whose triangles sit a few centimetres off the height texture).
  let groundPoint = vec3f(xz.x, gy + 0.03, xz.y);
  let toCam = frame.camPos - groundPoint;
  let lifted = groundPoint + toCam / max(length(toCam), 1e-3) * min(0.25, length(toCam) * 0.05);
  o.pos = frame.viewProj * vec4f(lifted, 1.0);
  o.quad = c;
  // Washed out by the water between here and the lens, like everything else.
  // A shadow is a hole in the light reaching the ground; the haze in front of
  // it fills that hole in, so a shadow twenty metres off should be barely
  // there. Multiplied in without this, distant fish printed hard dark blobs on
  // far cliffs, the more obviously since the cliff itself had faded.
  let haze = waterTransmittance(length(toCam));
  o.strength = fade * dot(haze, vec3f(0.3, 0.5, 0.2));
  return o;
}

@fragment
fn fs(i: BOut) -> @location(0) vec4f {
  let r2 = dot(i.quad, i.quad);
  let blob = exp(-r2 * 2.2) * (1.0 - smoothstep(0.75, 1.0, r2));
  let dark = min(0.8, blob * i.strength * 0.95);
  // Multiplied into the scene (see blend state).
  return vec4f(vec3f(1.0 - dark), 1.0);
}
`;

/** A fish (a school's leader, or a solitary fish) the camera can follow. */
export interface FollowCandidate {
  index: number;
  species: string;
  /** Body length in metres. */
  length: number;
  schoolSize: number;
  schoolRadius: number;
  /** Where the school lives, and how far from it the fish roam. */
  home: [number, number, number];
  roam: number;
}

export type FishSystem = RenderSystem & {
  setCamera(p: readonly number[], dir: readonly number[]): void;
  readonly candidates: FollowCandidate[];
  /**
   * Reads back position+scale and rotation (8 floats each) of the given fish
   * from the GPU; resolves a frame or two later.
   */
  readFish(indices: number[]): Promise<Float32Array>;
};

export async function createFish(
  renderer: Renderer,
  ctx: GenContext,
): Promise<FishSystem> {
  const device = renderer.device;
  const rng = ctx.rng('fish');
  const hi = ctx.quality.tierIndex >= 2;
  const speciesList = inventSpecies(rng, ctx);

  // Variant s * LODS + level.
  const lodPatches = speciesList.flatMap(s =>
    [0, 1, 2].map(level => speciesPatches(s, level, hi)),
  );
  const mesh = await buildMesh(
    device,
    'fish',
    meshWgsl,
    lodPatches.map(patches => ({patches, radius: 0.6})),
    rng.nextU32(),
  );

  // Species table.
  const SPECIES_FLOATS = SpeciesStruct.size / 4;
  const speciesData = new Float32Array(speciesList.length * SPECIES_FLOATS);
  speciesList.forEach((s, i) => {
    const len = (s.length[0] + s.length[1]) / 2;
    speciesData.set(
      [
        ...s.band,
        s.speed,
        s.maxSpeed,
        ...s.flock,
        s.turn,
        len,
        s.bodyType,
        s.tailBeat,
        ...s.colors.top.slice(0, 3),
        s.pattern,
        ...s.colors.belly.slice(0, 3),
        s.patternFreq,
        ...s.colors.accent.slice(0, 3),
        s.iridescence,
        ...s.colors.fin.slice(0, 3),
        s.finTranslucency,
        s.wander,
        s.homePull,
        s.body[0] * 0.72 * 0.28,
        s.eye * 1.15,
        s.curiosity ?? 0,
        // Schools keep well clear of the lens: out-of-focus fish right in
        // front of the camera read as ghosts.
        s.curiosity ? 2.2 : Math.min(3, 1.2 + len * 3),
        s.roam ?? 0,
        s.roam ? 0.9 / s.roam : 0,
        s.dart?.[0] ?? 0,
        s.dart?.[1] ?? 1,
        0,
        0,
        ...schoolParams(s),
      ],
      i * SPECIES_FLOATS,
    );
  });

  const coralHomes = coralHomesFor(ctx);
  // Initial fish, school by school. Each school shares a home; its first fish
  // leads and the rest follow.
  const total = speciesList.reduce((a, s) => a + s.count, 0);
  const FISH_FLOATS = FishStruct.size / 4;
  const fishData = new Float32Array(total * FISH_FLOATS);
  const ranges: {first: number; count: number}[] = [];
  const center = ctx.nav.o.center;
  const basinY = ctx.terrain.heightAt(center[0], center[1]);
  const hero = ctx.clusters[0];
  const navPoint = (): [number, number] => {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * ctx.nav.o.radiusAt(a) * 0.85;
    return [center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r];
  };
  const candidates: FollowCandidate[] = [];
  let idx = 0;
  speciesList.forEach((s, si) => {
    ranges.push({first: idx, count: s.count});
    const schoolSize = Math.max(1, s.school ?? 1);
    let home: [number, number, number, number] = [0, 0, 0, 1];
    let leader = idx;
    for (let n = 0; n < s.count; n++) {
      const schoolIndex = Math.floor(n / schoolSize);
      if (n % schoolSize === 0) {
        leader = idx;
        candidates.push({
          index: idx,
          species: s.name,
          length: (s.length[0] + s.length[1]) / 2,
          schoolSize: Math.min(schoolSize, s.count - n),
          schoolRadius: schoolParams(s)[0],
          home: [0, 0, 0],
          roam: s.homeRadius + schoolParams(s)[0],
        });
        if (s.home === 'reef' && ctx.clusters.length) {
          // A share of schools at the hero reef (where cameras look), the
          // rest spread over every reef.
          const c = rng.bool(0.2)
            ? ctx.clusters[0]
            : ctx.clusters[rng.int(0, ctx.clusters.length - 1)];
          const a = rng.range(0, Math.PI * 2);
          const r = rng.range(0, c.radius * 0.8);
          const x = c.x + Math.cos(a) * r;
          const z = c.z + Math.sin(a) * r;
          home = [x, ctx.surfaceTop(x, z) + 1.2, z, s.homeRadius];
        } else if (s.home === 'coral' && coralHomes.length) {
          // One school per coral head, alternating species between heads.
          const h =
            coralHomes[
              (schoolIndex * 2 + (s.name === 'anthias' ? 1 : 0)) %
                coralHomes.length
            ];
          home = [h[0], h[1] + 0.35, h[2], h[3] * 0.4 + 0.2];
        } else if (s.home === 'anemone' && ctx.anemones.length) {
          const a = ctx.anemones[schoolIndex % ctx.anemones.length];
          home = [a[0], a[1] + 0.1, a[2], s.homeRadius];
        } else if (s.home === 'open') {
          // The first school hangs beside the hero reef; the rest roam the basin.
          const [x, z] =
            schoolIndex === 0 && hero
              ? [hero.x + rng.range(-4, 4), hero.z + rng.range(-4, 4)]
              : navPoint();
          const g = ctx.terrain.heightAt(x, z);
          home = [
            x,
            Math.min(g + rng.range(3.5, 7), ctx.nav.ceiling() - 1.5),
            z,
            s.homeRadius,
          ];
        } else if (s.home === 'kelp' && ctx.kelpForests.length) {
          const kf = ctx.kelpForests[schoolIndex % ctx.kelpForests.length];
          const [sx, sz] = kf.stems[rng.int(0, kf.stems.length - 1)] ?? [
            kf.x,
            kf.z,
          ];
          home = [
            sx,
            ctx.terrain.heightAt(sx, sz) + rng.range(2, 6),
            sz,
            s.homeRadius,
          ];
        } else {
          const [x, z] = navPoint();
          home = [x, ctx.terrain.heightAt(x, z) + 2, z, s.homeRadius];
        }
        const cand = candidates[candidates.length - 1];
        cand.home = [home[0], home[1], home[2]];
      }
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, Math.max(home[3], 0.3) + schoolParams(s)[0]);
      const x = home[0] + Math.cos(a) * r;
      const z = home[2] + Math.sin(a) * r;
      const g = ctx.terrain.heightAt(x, z);
      const y = Math.min(
        Math.max(home[1] + rng.range(-1, 1), g + s.band[0] + 0.2),
        ctx.nav.ceiling() - 0.5,
      );
      const h = rng.range(0, Math.PI * 2);
      fishData.set(
        [
          x,
          y,
          z,
          si,
          Math.cos(h) * s.speed,
          0,
          Math.sin(h) * s.speed,
          rng.range(0, 10),
          ...home,
          leader,
          0,
          0,
          0,
        ],
        idx * FISH_FLOATS,
      );
      idx++;
    }
  });
  void basinY;

  const storage = (label: string, data: Float32Array, extra = 0) => {
    const b = device.createBuffer({
      label,
      size: Math.max(data.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extra,
    });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const stateA = storage('fish:state-a', fishData);
  const stateB = storage('fish:state-b', fishData);
  const speciesBuf = storage('fish:species', speciesData);
  const instanceBuf = device.createBuffer({
    label: 'fish:instances',
    size: Math.max(total * FishInstanceStruct.size, 16),
    // COPY_SRC: the creature-following camera reads a few fish back.
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const obstacleList = ctx.obstacles.slice(0, 96);
  const obstacleData = new Float32Array(Math.max(1, obstacleList.length) * 4);
  obstacleList.forEach((o, i) =>
    obstacleData.set([...o.center, o.radius], i * 4),
  );
  const obstacleBuf = storage('fish:obstacles', obstacleData);
  const simBuf = device.createBuffer({
    label: 'fish:sim-uniform',
    size: SimStruct.size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const simData = new ArrayBuffer(SimStruct.size);
  const simF = new Float32Array(simData);
  const simU = new Uint32Array(simData);

  const simModule = createShader(device, 'fish:sim-shader', simWgsl);
  const simPipeline = await device.createComputePipelineAsync({
    label: 'fish:sim-pipeline',
    layout: 'auto',
    compute: {module: simModule, entryPoint: 'main'},
  });
  const clampSampler = device.createSampler({
    label: 'fish:terrain-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
  });
  const simGroups = [
    [stateA, stateB],
    [stateB, stateA],
  ].map(([src, dst], i) =>
    device.createBindGroup({
      label: `fish:sim-bind-group-${i}`,
      layout: simPipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: {buffer: simBuf}},
        {binding: 1, resource: {buffer: src}},
        {binding: 2, resource: {buffer: dst}},
        {binding: 3, resource: {buffer: speciesBuf}},
        {binding: 4, resource: {buffer: instanceBuf}},
        {binding: 5, resource: {buffer: obstacleBuf}},
        {
          binding: 6,
          resource: renderer.textures.terrain.createView({
            label: 'fish:terrain-view',
          }),
        },
        {binding: 7, resource: clampSampler},
      ],
    }),
  );

  const renderModule = createShader(
    device,
    'fish:render-shader',
    renderWgslFor(true),
  );
  const bodyModule = createShader(
    device,
    'fish:body-render-shader',
    renderWgslFor(false),
  );
  const castsShadow = speciesList.map(s => s.length[1] >= 0.3);
  const S = speciesList.length;
  const buckets = S * LODS;

  // --- Culling and detail selection (GPU) ---
  const rangeData = new Uint32Array(S * 2);
  ranges.forEach((r, i) => rangeData.set([r.first, r.count], i * 2));
  const rangeBuf = device.createBuffer({
    label: 'fish:ranges',
    size: rangeData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(rangeBuf, 0, rangeData);
  const countsBuf = device.createBuffer({
    label: 'fish:bucket-counts',
    size: buckets * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const countsZero = new Uint32Array(buckets);
  const visibleBuf = device.createBuffer({
    label: 'fish:visible',
    size: Math.max(total * LODS * 4, 16),
    usage: GPUBufferUsage.STORAGE,
  });
  const cullBuf = device.createBuffer({
    label: 'fish:cull-uniform',
    size: CullStruct.size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const cullPlanes = new Float32Array(16);
  const cullData = new ArrayBuffer(CullStruct.size);
  const cullF = new Float32Array(cullData);
  const cullU = new Uint32Array(cullData);
  const cullPipeline = await device.createComputePipelineAsync({
    label: 'fish:cull-pipeline',
    layout: 'auto',
    compute: {
      module: createShader(device, 'fish:cull-shader', cullWgsl),
      entryPoint: 'main',
    },
  });
  const cullGroup = device.createBindGroup({
    label: 'fish:cull-bind-group',
    layout: cullPipeline.getBindGroupLayout(0),
    entries: [
      {binding: 0, resource: {buffer: cullBuf}},
      {binding: 1, resource: {buffer: instanceBuf}},
      {binding: 2, resource: {buffer: rangeBuf}},
      {binding: 3, resource: {buffer: countsBuf}},
      {binding: 4, resource: {buffer: visibleBuf}},
    ],
  });
  // Indirect draw arguments: per bucket a body draw and a fin draw. Index
  // ranges are fixed; instance counts are filled in on the GPU every frame.
  const argData = new Uint32Array(buckets * 10);
  const variantOf = (s: number, level: number) =>
    mesh.variants[s * LODS + level];
  for (let si = 0; si < S; si++) {
    for (let level = 0; level < LODS; level++) {
      const b = si * LODS + level;
      const v = variantOf(si, level);
      const body = bodyIndices(speciesList[si], lodPatches[b]);
      // The tiny level draws everything (fins included) in the body pass.
      const bodyCount = level === LODS - 1 ? v.indexCount : body;
      argData.set([bodyCount, 0, v.firstIndex, 0, 0], b * 10);
      argData.set(
        [
          level === LODS - 1 ? 0 : v.indexCount - body,
          0,
          v.firstIndex + body,
          0,
          0,
        ],
        b * 10 + 5,
      );
    }
  }
  const argsBuf = device.createBuffer({
    label: 'fish:indirect-args',
    size: argData.byteLength,
    usage:
      GPUBufferUsage.INDIRECT |
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(argsBuf, 0, argData);
  const indirectPipeline = await device.createComputePipelineAsync({
    label: 'fish:indirect-pipeline',
    layout: 'auto',
    compute: {
      module: createShader(device, 'fish:indirect-shader', indirectWgsl),
      entryPoint: 'main',
    },
  });
  const indirectGroup = device.createBindGroup({
    label: 'fish:indirect-bind-group',
    layout: indirectPipeline.getBindGroupLayout(0),
    entries: [
      {binding: 0, resource: {buffer: countsBuf}},
      {binding: 1, resource: {buffer: argsBuf}},
    ],
  });
  // Per-draw info (dynamic uniform offsets): one entry per bucket, then one
  // direct (all fish of a species) entry per species for the shadow pass.
  const INFO_ALIGN = 256;
  const infoData = new Uint32Array(((buckets + S) * INFO_ALIGN) / 4);
  for (let si = 0; si < S; si++) {
    for (let level = 0; level < LODS; level++) {
      const b = si * LODS + level;
      infoData.set(
        [ranges[si].first * LODS + level * ranges[si].count, 0],
        (b * INFO_ALIGN) / 4,
      );
    }
    infoData.set([ranges[si].first, 1], ((buckets + si) * INFO_ALIGN) / 4);
  }
  const infoBuf = device.createBuffer({
    label: 'fish:draw-info',
    size: infoData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(infoBuf, 0, infoData);
  const localLayout = device.createBindGroupLayout({
    label: 'fish:local-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {type: 'read-only-storage'},
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {type: 'read-only-storage'},
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX,
        buffer: {type: 'read-only-storage'},
      },
      {
        binding: 3,
        visibility: GPUShaderStage.VERTEX,
        buffer: {type: 'uniform', hasDynamicOffset: true, minBindingSize: 8},
      },
    ],
  });
  const layout = device.createPipelineLayout({
    label: 'fish:pipeline-layout',
    bindGroupLayouts: [renderer.globals.layout, localLayout],
  });
  const colorPipeline = (label: string, module: GPUShaderModule) =>
    device.createRenderPipelineAsync({
      label,
      layout,
      vertex: {module, entryPoint: 'vs', buffers: [vertexLayout]},
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{format: HDR_FORMAT}, {format: VELOCITY_FORMAT}],
      },
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    });
  const [pipeline, bodyPipeline, shadowPipeline] = await Promise.all([
    colorPipeline('fish:fin-pipeline', renderModule),
    colorPipeline('fish:body-pipeline', bodyModule),
    device.createRenderPipelineAsync({
      label: 'fish:shadow-pipeline',
      layout,
      vertex: {
        module: renderModule,
        entryPoint: 'vsShadow',
        buffers: [vertexLayout],
      },
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    }),
  ]);
  const blobModule = createShader(device, 'fish:blob-shader', blobShadowWgsl);
  const blobLayout = device.createBindGroupLayout({
    label: 'fish:blob-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: {type: 'read-only-storage'},
      },
    ],
  });
  const blobPipeline = await device.createRenderPipelineAsync({
    label: 'fish:blob-pipeline',
    layout: device.createPipelineLayout({
      label: 'fish:blob-pipeline-layout',
      bindGroupLayouts: [renderer.globals.layout, blobLayout],
    }),
    vertex: {module: blobModule, entryPoint: 'vs'},
    fragment: {
      module: blobModule,
      entryPoint: 'fs',
      targets: [
        {
          format: HDR_FORMAT,
          // Multiply: dst * src.
          blend: {
            color: {srcFactor: 'zero', dstFactor: 'src', operation: 'add'},
            alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'},
          },
        },
      ],
    },
    primitive: {topology: 'triangle-list', cullMode: 'none'},
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: 'greater-equal',
    },
  });
  const blobGroup = device.createBindGroup({
    label: 'fish:blob-bind-group',
    layout: blobLayout,
    entries: [{binding: 0, resource: {buffer: instanceBuf}}],
  });
  const renderGroup = device.createBindGroup({
    label: 'fish:render-bind-group',
    layout: localLayout,
    entries: [
      {binding: 0, resource: {buffer: instanceBuf}},
      {binding: 1, resource: {buffer: speciesBuf}},
      {binding: 2, resource: {buffer: visibleBuf}},
      {binding: 3, resource: {buffer: infoBuf, size: 8}},
    ],
  });

  let flip = 0;
  let camPos: readonly number[] = [0, 0, 0];
  let camDir: readonly number[] = [0, 0, -1];
  const bind = (pass: GPURenderPassEncoder, p: GPURenderPipeline) => {
    pass.setPipeline(p);
    pass.setVertexBuffer(0, mesh.vertexBuffer);
    pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
  };
  const drawVisible = (pass: GPURenderPassEncoder, fins: boolean) => {
    for (let b = 0; b < buckets; b++) {
      const level = b % LODS;
      if (fins && level === LODS - 1) {
        continue;
      }
      pass.setBindGroup(1, renderGroup, [b * INFO_ALIGN]);
      pass.drawIndexedIndirect(argsBuf, (b * 10 + (fins ? 5 : 0)) * 4);
    }
  };

  const staging: GPUBuffer[] = [];
  const READ_BYTES = 32;
  const readFish = async (indices: number[]) => {
    const size = Math.max(indices.length, 1) * READ_BYTES;
    const i = staging.findIndex(b => b.size >= size);
    const buf =
      i >= 0
        ? staging.splice(i, 1)[0]
        : device.createBuffer({
            label: 'fish:readback',
            size: Math.ceil(size / 1024) * 1024,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
    const encoder = device.createCommandEncoder({
      label: 'fish:readback-encoder',
    });
    indices.forEach((fishIndex, k) =>
      encoder.copyBufferToBuffer(
        instanceBuf,
        fishIndex * FishInstanceStruct.size,
        buf,
        k * READ_BYTES,
        READ_BYTES,
      ),
    );
    device.queue.submit([encoder.finish({label: 'fish:readback-commands'})]);
    await buf.mapAsync(GPUMapMode.READ, 0, size);
    const out = new Float32Array(buf.getMappedRange(0, size).slice(0));
    buf.unmap();
    staging.push(buf);
    return out;
  };

  const system: FishSystem = {
    name: 'fish',
    candidates,
    readFish,
    setCamera(p, dir) {
      camPos = p;
      camDir = dir;
    },
    update(fc: FrameContext) {
      // Sub-step large time steps for stability. Each step needs its own
      // uniform contents, so large steps are split across submits.
      const steps = Math.min(4, Math.max(1, Math.ceil(fc.dt / (1 / 20))));
      for (let s = 0; s < steps; s++) {
        simF[0] = fc.dt / steps;
        simF[1] = fc.time - fc.dt + (fc.dt * (s + 1)) / steps;
        simU[2] = total;
        simU[3] = obstacleList.length;
        simF.set(camPos, 4);
        simF[7] = ctx.nav.ceiling();
        simF.set(camDir, 8);
        simF[11] = ctx.desc.terrain.worldSize;
        const last = s === steps - 1;
        const encoder = last
          ? fc.encoder
          : device.createCommandEncoder({label: 'fish:substep-encoder'});
        device.queue.writeBuffer(simBuf, 0, simData);
        const pass = encoder.beginComputePass({label: 'fish:sim-pass'});
        pass.setPipeline(simPipeline);
        pass.setBindGroup(0, simGroups[flip]);
        pass.dispatchWorkgroups(Math.ceil(total / 64));
        pass.end();
        if (!last) {
          device.queue.submit([
            encoder.finish({label: 'fish:substep-commands'}),
          ]);
        }
        flip = 1 - flip;
      }

      // Cull and pick detail levels, then fill in the indirect draw counts.
      const view = fc.view;
      cullF.set(view.viewProj, 0);
      cullF.set(sidePlanes(view.viewProj, cullPlanes), 16);
      cullF.set(view.camPos, 32);
      cullF[35] = view.focalPx;
      cullF[36] = view.maxDistance;
      cullU[37] = total;
      cullF[38] = 70;
      cullF[39] = 14;
      device.queue.writeBuffer(cullBuf, 0, cullData);
      device.queue.writeBuffer(countsBuf, 0, countsZero);
      const cull = fc.encoder.beginComputePass({label: 'fish:cull-pass'});
      cull.setPipeline(cullPipeline);
      cull.setBindGroup(0, cullGroup);
      cull.dispatchWorkgroups(Math.ceil(total / 64));
      cull.end();
      const args = fc.encoder.beginComputePass({label: 'fish:indirect-pass'});
      args.setPipeline(indirectPipeline);
      args.setBindGroup(0, indirectGroup);
      args.dispatchWorkgroups(Math.ceil(buckets / 16));
      args.end();
    },
    drawOpaque: pass => {
      bind(pass, bodyPipeline);
      drawVisible(pass, false);
      bind(pass, pipeline);
      drawVisible(pass, true);
    },
    // Only fish big enough to cast a readable shadow go into the shadow map,
    // all of them (off-screen fish shade what's on screen), at the tiny level.
    drawShadow: pass => {
      bind(pass, shadowPipeline);
      for (let si = 0; si < S; si++) {
        if (!castsShadow[si] || !ranges[si].count) {
          continue;
        }
        const v = variantOf(si, LODS - 1);
        pass.setBindGroup(1, renderGroup, [(buckets + si) * INFO_ALIGN]);
        pass.drawIndexed(v.indexCount, ranges[si].count, v.firstIndex, 0, 0);
      }
    },
    drawTransparent: pass => {
      pass.setPipeline(blobPipeline);
      pass.setBindGroup(1, blobGroup);
      pass.draw(6, total);
    },
  };
  console.log(
    `[fish] ${speciesList.map(s => `${s.name}x${s.count}`).join(', ')}`,
  );
  return system;
}
