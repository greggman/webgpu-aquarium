// Fish and rays: procedural species, GPU boids, and swimming animation.
//
// Each seed invents a set of species (body shape, fins, colour pattern and
// behaviour). Meshes come from the GPU mesh builder, one variant per species.
// A compute shader runs flocking with terrain/obstacle/camera avoidance and
// writes the instance buffer the renderer draws from.

import {createShader} from '../gpu/device.ts';
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
});

const FishStruct = defineStruct('Fish', {
  pos: 'vec3f',
  species: 'f32',
  vel: 'vec3f',
  phase: 'f32',
  home: 'vec4f',
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

type Home = 'open' | 'reef' | 'anemone' | 'basin' | 'kelp';

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
}

const hsv = (h: number, s: number, v: number): number[] => {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
};

/** Invents this seed's species. */
function inventSpecies(rng: Rng, ctx: GenContext): SpeciesDef[] {
  // A lush sea: plenty of fish everywhere (scaled down on smaller tiers).
  const k = ctx.quality.density * 1.7;
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
    count: Math.round(rng.int(480, 650) * k),
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
    homeRadius: 5,
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
    count: Math.max(2, Math.round(rng.int(3, 5) * Math.min(1, k * 1.5))),
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

  // Fish that live among the kelp.
  if (ctx.kelpForests.length) {
    list.push({
      name: 'kelpfish',
      count: Math.round(rng.int(30, 45) * k),
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
      count: Math.min(
        ctx.anemones.length * 2,
        Math.round(16 * Math.max(k, 0.5)),
      ),
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
      ? Math.max(1, Math.round(2 * Math.min(1, k)))
      : Math.max(2, Math.round(rng.int(4, 7) * Math.min(1, k))),
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

function speciesPatches(s: SpeciesDef, hi: boolean): Patch[] {
  const p = (part: number, segU: number, segV: number): Patch => {
    const params = new Array(16).fill(0);
    s.body.forEach((v, i) => (params[i] = v));
    params[12] = s.bodyType;
    params[14] = part;
    return {segU, segV, params};
  };
  if (s.bodyType === 1) {
    return [
      p(Part.RayTop, hi ? 40 : 20, hi ? 24 : 12),
      p(Part.RayBottom, hi ? 40 : 20, hi ? 24 : 12),
      p(Part.RayTail, 4, 8),
    ];
  }
  return [
    p(Part.Body, hi ? 28 : 14, hi ? 36 : 16),
    p(Part.Tail, 6, 6),
    p(Part.Dorsal, 10, 3),
    p(Part.Anal, 6, 3),
    p(Part.PectoralL, 3, 3),
    p(Part.PectoralR, 3, 3),
  ];
}

// ---------------------------------------------------------------------------
// Simulation

// Neighbour search: a spatial hash grid rebuilt on the GPU each step, so each
// fish checks only the fish in the 27 cells around it (O(n)) instead of every
// other fish (O(n^2)).
const GRID_CELLS = 8192;
const GRID_CAP = 20;
const GRID_CELL_SIZE = 2.2;

const gridWgsl = /* wgsl */ `
const GRID_CELLS = ${GRID_CELLS}u;
const GRID_CAP = ${GRID_CAP}u;
const GRID_CELL_SIZE = ${GRID_CELL_SIZE};

fn gridCell(p: vec3f) -> vec3i {
  return vec3i(floor(p / GRID_CELL_SIZE));
}

fn gridHash(c: vec3i) -> u32 {
  let h = (bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u);
  return h % GRID_CELLS;
}
`;

const gridBuildWgsl = /* wgsl */ `
${SimStruct.wgsl}
${FishStruct.wgsl}
${gridWgsl}
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> fishIn: array<Fish>;
@group(0) @binding(2) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> items: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= sim.count) {
    return;
  }
  let h = gridHash(gridCell(fishIn[i].pos));
  let slot = atomicAdd(&counts[h], 1u);
  if (slot < GRID_CAP) {
    items[h * GRID_CAP + slot] = i;
  }
}
`;

const simWgsl = /* wgsl */ `
${gridWgsl}
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
@group(0) @binding(8) var<storage, read> gridCounts: array<u32>;
@group(0) @binding(9) var<storage, read> gridItems: array<u32>;

fn groundAt(xz: vec2f) -> f32 {
  return textureSampleLevel(tTerrain, sClamp, xz / sim.worldSize + 0.5, 0.0).r;
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
  let nd = sp.flock.w;

  var sep = vec3f(0.0);
  var ali = vec3f(0.0);
  var coh = vec3f(0.0);
  var n = 0.0;
  let ownSep = max(len * 1.6, 0.12);
  let home = gridCell(f.pos);
  var visited = array<u32, 27>();
  var nVisited = 0u;
  for (var cz = -1; cz <= 1; cz++) {
  for (var cy = -1; cy <= 1; cy++) {
  for (var cx = -1; cx <= 1; cx++) {
    let h = gridHash(home + vec3i(cx, cy, cz));
    // Distinct cells can hash to the same bucket: visit each bucket once.
    var seen = false;
    for (var k = 0u; k < nVisited; k++) {
      seen = seen || visited[k] == h;
    }
    if (seen) {
      continue;
    }
    visited[nVisited] = h;
    nVisited++;
    let inCell = min(gridCounts[h], GRID_CAP);
    for (var s = 0u; s < inCell; s++) {
    let j = gridItems[h * GRID_CAP + s];
    if (j == i) {
      continue;
    }
    let o = fishIn[j];
    let d = o.pos - f.pos;
    let d2 = dot(d, d);
    let same = o.species == f.species;
    // Keep clear of the bigger of the two fish, so a large fish never swims
    // through a small one.
    let sepDist = select(max(ownSep, species[u32(o.species)].motion.y * 1.6), ownSep, same);
    let reach = select(sepDist, max(nd, sepDist), same);
    if (d2 > reach * reach) {
      continue;
    }
    let dist = sqrt(d2) + 1e-4;
    if (dist < sepDist) {
      sep -= d / dist * (sepDist - dist) / sepDist * select(3.0, 1.0, same);
    }
    if (same) {
      ali += o.vel;
      coh += o.pos;
      n += 1.0;
    }
    }
  }
  }
  }

  var acc = vec3f(0.0);
  let roam = sp.behavior.z;
  if (n > 0.0) {
    acc += (ali / n - f.vel) * sp.flock.y;
    var toCenter = coh / n - f.pos;
    if (roam > 0.0) {
      // Roaming schools cohere sideways but barely along their heading, so
      // they string out into streaming ribbons instead of balls.
      let heading = normalize(f.vel + vec3f(1e-5, 0.0, 0.0));
      let along = dot(toCenter, heading);
      toCenter -= heading * along * 0.85;
    }
    acc += toCenter * sp.flock.x;
  }
  acc += sep * sp.flock.z * 4.0;

  // Stay near home (which, for roaming schools, travels a slow wobbly loop).
  let roamA = sim.time * sp.behavior.w;
  let roamOff = vec3f(cos(roamA), 0.12 * sin(roamA * 2.0), sin(roamA) * 0.7) * roam;
  let toHome = f.home.xyz + roamOff - f.pos;
  let hd = length(toHome);
  if (hd > f.home.w) {
    acc += toHome / hd * (hd - f.home.w) * sp.extra.y;
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
    let id = f32(i);
    // Each curious fish holds its own spot so they don't pile up on one point.
    let side = sin(sim.time * 0.15 + id * 2.1) * 1.0 + (fract(id * 0.618) - 0.5) * 4.0;
    let right = normalize(cross(sim.camDir, vec3f(0.0, 1.0, 0.0)) + vec3f(1e-4));
    // Far enough to stay inside the focus range (closer, they fill the lens as blurry shapes).
    let spot = sim.camPos + sim.camDir * (4.0 + fract(id * 0.37) * 3.0) + right * side;
    let toSpot = spot - f.pos;
    acc += toSpot * curious * 1.4 * smoothstep(22.0, 6.0, cd);
  }

  // Wander.
  let fi = f32(i);
  acc += vec3f(
    sin(sim.time * 0.37 + fi * 1.7) + sin(sim.time * 0.13 + fi * 0.3),
    sin(sim.time * 0.29 + fi * 2.3) * 0.25,
    cos(sim.time * 0.41 + fi * 0.9) + cos(sim.time * 0.11 + fi * 1.1),
  ) * sp.extra.x;

  var speed = length(f.vel);
  let dir = select(vec3f(0.0, 0.0, 1.0), f.vel / speed, speed > 1e-4);
  acc += dir * (sp.band.z - speed) * 0.8;

  var vel = f.vel + acc * dt * sp.motion.x;
  speed = clamp(length(vel), sp.band.z * 0.3, sp.band.w);
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
  let inst = instances[v.instance];
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
  o.instance = v.instance;
  o.ao = v.position.w;
  o.curClip = frame.viewProjNoJitter * vec4f(world, 1.0);
  o.prevClip = frame.prevViewProjNoJitter * vec4f(prevWorld, 1.0);
  return o;
}

@vertex
fn vsShadow(v: VIn) -> @builtin(position) vec4f {
  let inst = instances[v.instance];
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
export type FishSystem = RenderSystem & {
  setCamera(p: readonly number[], dir: readonly number[]): void;
};

export async function createFish(
  renderer: Renderer,
  ctx: GenContext,
): Promise<FishSystem> {
  const device = renderer.device;
  const rng = ctx.rng('fish');
  const hi = ctx.quality.tierIndex >= 2;
  const speciesList = inventSpecies(rng, ctx);

  const mesh = await buildMesh(
    device,
    'fish',
    meshWgsl,
    // Small, numerous fish never cover many pixels: the low-detail mesh is
    // plenty. Only the bigger species get the fine one.
    speciesList.map(s => ({
      patches: speciesPatches(s, hi && s.length[1] >= 0.3),
      radius: 0.6,
    })),
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
        s.curiosity ? 2.2 : Math.max(3.5, 1.5 + len * 3),
        s.roam ?? 0,
        s.roam ? 0.9 / s.roam : 0,
      ],
      i * SPECIES_FLOATS,
    );
  });

  // Initial fish.
  const total = speciesList.reduce((a, s) => a + s.count, 0);
  const fishData = new Float32Array(total * 12);
  const ranges: {first: number; count: number}[] = [];
  const center = ctx.nav.o.center;
  const basinY = ctx.terrain.heightAt(center[0], center[1]);
  // The bait ball hangs in the water column just beside the hero reef, where
  // the cameras and the attract tour will see it.
  const hero = ctx.clusters[0];
  const openHome: [number, number, number] = hero
    ? [
        hero.x + rng.range(-4, 4),
        Math.min(hero.y + 4.5, ctx.nav.ceiling() - 1.5),
        hero.z + rng.range(-4, 4),
      ]
    : [center[0], Math.min(basinY + 6, ctx.nav.ceiling() - 2), center[1]];
  let idx = 0;
  speciesList.forEach((s, si) => {
    ranges.push({first: idx, count: s.count});
    for (let n = 0; n < s.count; n++) {
      let home: [number, number, number, number];
      if (s.home === 'reef' && ctx.clusters.length) {
        const c =
          ctx.clusters[
            Math.min(
              ctx.clusters.length - 1,
              // A good share gathers at the hero reef, where the cameras look.
              rng.bool(0.6)
                ? 0
                : Math.floor(Math.pow(rng.float(), 1.5) * ctx.clusters.length),
            )
          ];
        home = [c.x, c.y + 1.2, c.z, c.radius + s.homeRadius];
      } else if (s.home === 'anemone' && ctx.anemones.length) {
        const a = ctx.anemones[n % ctx.anemones.length];
        home = [a[0], a[1] + 0.1, a[2], s.homeRadius];
      } else if (s.home === 'open') {
        home = [...openHome, s.homeRadius];
      } else if (s.home === 'kelp' && ctx.kelpForests.length) {
        const kf = ctx.kelpForests[n % ctx.kelpForests.length];
        home = [kf.x, ctx.terrain.heightAt(kf.x, kf.z) + 3, kf.z, s.homeRadius];
      } else {
        home = [center[0], basinY + 2, center[1], s.homeRadius];
      }
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, Math.max(home[3], 0.3));
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
        ],
        idx * 12,
      );
      idx++;
    }
  });

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
    usage: GPUBufferUsage.STORAGE,
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
  const gridCounts = device.createBuffer({
    label: 'fish:grid-counts',
    size: GRID_CELLS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const gridItems = device.createBuffer({
    label: 'fish:grid-items',
    size: GRID_CELLS * GRID_CAP * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const gridZeros = new Uint32Array(GRID_CELLS);
  const gridModule = createShader(device, 'fish:grid-shader', gridBuildWgsl);
  const gridPipeline = await device.createComputePipelineAsync({
    label: 'fish:grid-pipeline',
    layout: 'auto',
    compute: {module: gridModule, entryPoint: 'main'},
  });
  const gridGroups = [stateA, stateB].map((src, i) =>
    device.createBindGroup({
      label: `fish:grid-bind-group-${i}`,
      layout: gridPipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: {buffer: simBuf}},
        {binding: 1, resource: {buffer: src}},
        {binding: 2, resource: {buffer: gridCounts}},
        {binding: 3, resource: {buffer: gridItems}},
      ],
    }),
  );
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
        {binding: 8, resource: {buffer: gridCounts}},
        {binding: 9, resource: {buffer: gridItems}},
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
  // Index count of the leading body patch(es) of each species' mesh; the rest
  // are fins.
  const bodyIndexCount = speciesList.map(s => {
    const patches = speciesPatches(s, hi && s.length[1] >= 0.3);
    const body = s.bodyType === 1 ? patches : patches.slice(0, 1);
    return body.reduce((n, p) => n + p.segU * p.segV * 6, 0);
  });
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
  const renderGroup = device.createBindGroup({
    label: 'fish:render-bind-group',
    layout: localLayout,
    entries: [
      {binding: 0, resource: {buffer: instanceBuf}},
      {binding: 1, resource: {buffer: speciesBuf}},
    ],
  });

  let flip = 0;
  let camPos: readonly number[] = [0, 0, 0];
  let camDir: readonly number[] = [0, 0, -1];
  const draw = (
    pass: GPURenderPassEncoder,
    p: GPURenderPipeline,
    part: 'all' | 'body' | 'fins' | 'shadow',
  ) => {
    pass.setPipeline(p);
    pass.setBindGroup(1, renderGroup);
    pass.setVertexBuffer(0, mesh.vertexBuffer);
    pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
    ranges.forEach((r, s) => {
      if (part === 'shadow' && !castsShadow[s]) {
        return;
      }
      const v = mesh.variants[s];
      const body = bodyIndexCount[s];
      const first = part === 'fins' ? v.firstIndex + body : v.firstIndex;
      const count =
        part === 'all' || part === 'shadow'
          ? v.indexCount
          : part === 'body'
            ? body
            : v.indexCount - body;
      if (count > 0 && r.count > 0) {
        pass.drawIndexed(count, r.count, first, 0, r.first);
      }
    });
  };

  const system: FishSystem = {
    name: 'fish',
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
        device.queue.writeBuffer(gridCounts, 0, gridZeros);
        const gridPass = encoder.beginComputePass({label: 'fish:grid-pass'});
        gridPass.setPipeline(gridPipeline);
        gridPass.setBindGroup(0, gridGroups[flip]);
        gridPass.dispatchWorkgroups(Math.ceil(total / 64));
        gridPass.end();
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
    },
    drawOpaque: pass => {
      draw(pass, bodyPipeline, 'body');
      draw(pass, pipeline, 'fins');
    },
    // Only fish big enough to cast a readable shadow go into the shadow map.
    drawShadow: pass => draw(pass, shadowPipeline, 'shadow'),
  };
  console.log(
    `[fish] ${speciesList.map(s => `${s.name}x${s.count}`).join(', ')}`,
  );
  return system;
}
