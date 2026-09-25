// Ground cover: the small stuff underfoot — turf, weed tufts, shell chips and
// rubble — thick around the camera and gone a little way out.
//
// It is never stored. Every frame a fixed number of instances is drawn, and
// each one works out for itself which cell of a grid around the camera it is,
// hashes that cell for a position and a shape, reads the seabed's height, slope
// and material there, and either grows or collapses to nothing. The grid is
// snapped to world coordinates, so nothing swims along with the camera, and
// there is no buffer to fill, no culling to do and nothing to keep in memory:
// it costs one draw and some vertex work.
//
// This is what makes a view lush regardless of the window's shape. A portrait
// window sees a third of the width a desktop one does, so what saves it is not
// more scenery in the distance but more life within a few metres of the lens.

import {createShader} from '../gpu/device.ts';
import {surfaceLib} from '../shaders/index.ts';
import type {Quality} from '../core/quality.ts';
import type {CullView, FrameContext, RenderSystem} from './renderer.ts';

/** Cells across the patch that follows the camera. */
const GRID = 128;
/** Metres per cell. */
const CELL = 0.22;
/**
 * Vertices per tuft: sixteen blades of two triangles each.
 *
 * Blades per tuft is the cheap axis. A tuft costs one instance however many
 * blades it has, so sixteen from one root reads as thick turf where sixteen
 * separate roots would cost sixteen times the setup. Games usually paint the blades onto
 * one card instead; that needs an alpha cutout, and discarding fragments is
 * what wrecked performance on Apple's tile GPUs here before.
 */
const BLADE_VERTS = 96;

const shader = /* wgsl */ `
${surfaceLib}

struct Cover {
  /** Grid origin in world space, and the cell size. */
  origin: vec2f,
  cell: f32,
  radius: f32,
};
@group(1) @binding(0) var<uniform> cover: Cover;

/**
 * Four values from a cell's integer coordinates.
 *
 * Integer, not the cell's world position: the grid slides with the camera, so
 * the same cell's position comes out of a different sum each time it moves, and
 * the usual sin-based hash turns a last-bit difference into an entirely
 * different number. Every tuft in view then changed its mind about where it was
 * and whether it existed at all, once per cell of camera movement. Bit mixing
 * on the indices gives the same answer for a cell for as long as it exists.
 */
/** Smooth 0-1 noise on an integer lattice. */
fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hashCell(vec2i(i)).x;
  let b = hashCell(vec2i(i) + vec2i(1, 0)).x;
  let c = hashCell(vec2i(i) + vec2i(0, 1)).x;
  let d = hashCell(vec2i(i) + vec2i(1, 1)).x;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * Where there is meadow at all, 0 to 1.
 *
 * Bands, not blobs. Thresholding noise gives round patches with fat middles and
 * ragged edges, which reads as spray paint; seagrass grows in runs. Taking the
 * level sets instead — pushing a warped noise field through a sine — gives
 * meandering bands of roughly even width, the labyrinth pattern, with clear
 * sand between them. A slower field decides where there are any bands at all,
 * so whole stretches of floor stay bare.
 */
fn meadowAt(xz: vec2f) -> f32 {
  // Band width follows from how fast the field turns: a swing of A radians over
  // a lattice of k per metre puts a cycle every 2*pi/(A*k) metres, and a band
  // is half of that. A = 17 at k = 0.12 gives runs two or three metres across.
  let warp = vec2f(noise2(xz * 0.04 + 4.0), noise2(xz * 0.04 + 19.0)) - 0.5;
  let p = xz * 0.12 + warp * 1.6;
  let field = (noise2(p) - 0.5) * 17.0 + (noise2(p * 2.6) - 0.5) * 4.0;
  let band = smoothstep(-0.25, 0.4, sin(field));
  let region = smoothstep(0.35, 0.62, noise2(xz * 0.013 + 51.0));
  return band * region;
}

fn hashCell(c: vec2i) -> vec4f {
  var n = (u32(c.x) * 1597334673u) ^ (u32(c.y) * 3812015801u);
  var o: vec4f;
  for (var i = 0u; i < 4u; i++) {
    n ^= n >> 16u;
    n *= 2246822519u;
    n ^= n >> 13u;
    n *= 3266489917u;
    n ^= n >> 16u;
    o[i] = f32(n >> 8u) / 16777216.0;
  }
  return o;
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) tint: vec3f,
  @location(3) along: f32,
  @location(4) prevClip: vec4f,
  @location(5) curClip: vec4f,
};

/** Height, slope and material of the seabed at a point. */
fn groundAt(xz: vec2f) -> vec4f {
  return textureSampleLevel(tTerrain, sLinearClamp, xz / frame.terrain.x + 0.5, 0.0);
}
fn maskAt(xz: vec2f) -> vec4f {
  return textureSampleLevel(tTerrainMask, sLinearClamp, xz / frame.terrain.x + 0.5, 0.0);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  // Which cell of the patch this instance is, and where that cell sits.
  let cell = vec2i(cover.origin) + vec2i(i32(ii % ${GRID}u), i32(ii / ${GRID}u));
  let cellPos = vec2f(cell) * cover.cell;
  let h = hashCell(cell);
  let xz = cellPos + (h.xy - 0.5) * cover.cell * 0.9;

  let g = groundAt(xz);
  let m = maskAt(xz);
  let normal = normalize(vec3f(g.g, sqrt(max(1.0 - g.g * g.g - g.b * g.b, 0.0)), g.b));
  let base = vec3f(xz.x, g.r, xz.y);

  // Thinner with distance, and gone before the edge of the patch, so nothing
  // ever pops into being in view. Measured flat: the patch follows the camera
  // horizontally, so bringing its height into the fade would empty the whole
  // thing as the camera rose and fill it again as it sank.
  let dist = distance(base.xz, frame.camPos.xz);
  let fade = smoothstep(cover.radius, cover.radius * 0.72, dist);
  // Turf takes to sand and reef flats, not to bare rock or a wall, and it
  // grows in drifts. Inside a drift nearly every cell has a tuft, outside it
  // almost none: thin everywhere reads as a dusting, thick in places reads as
  // meadow, for the same number of tufts drawn.
  let sand = (1.0 - m.r) * (0.45 + m.g * 0.4 + m.b * 1.0);
  let flat = smoothstep(0.62, 0.86, normal.y);
  let meadow = meadowAt(xz) * clamp(sand, 0.0, 1.0);
  // Inside a drift nearly every cell has a tuft: thick where there is any.
  let grow = fade * flat * step(h.z, meadow * 1.6);

  let blade = vi / 6u;
  let corner = vi % 6u;
  let bh = hashCell(cell * 7 + vec2i(i32(blade) * 31, i32(blade) * 17));
  // Two triangles per blade: a tapered strip from the ground to the tip.
  let up = f32(corner == 1u || corner == 2u || corner == 4u);
  let side = f32(corner == 0u || corner == 1u || corner == 5u) * 2.0 - 1.0;

  let lean = bh.x * 6.2831853;
  let dir = vec2f(cos(lean), sin(lean));
  // Short and broad, like turf: tall thin blades read as scattered sticks.
  // Small and narrow: at any size worth noticing individually these read as
  // cones stuck in the sand rather than as turf.
  // Taller where the drift is thickest, wispy at its edge.
  let height = (0.09 + bh.y * 0.19) * (0.55 + 0.75 * meadow) * grow;
  let width = (0.008 + bh.z * 0.012) * (1.0 - up * 0.65);

  // Current: the tips stream, the bases hold.
  let phase = frame.time * 1.4 + dot(xz, vec2f(0.4, 0.3)) + f32(blade);
  let sway = (sin(phase) * 0.25 + 0.55) * up * up * height;

  var p = base;
  // Spread around the root, so a tuft is a clump rather than a fan.
  p += vec3f(dir.x, 0.0, dir.y) * bh.w * 0.19;
  p.y += up * height;
  p += vec3f(dir.y, 0.0, -dir.x) * side * width;
  p += vec3f(0.8, 0.0, 0.35) * sway;

  o.world = p;
  o.pos = frame.viewProj * vec4f(p, 1.0);
  o.curClip = frame.viewProjNoJitter * vec4f(p, 1.0);
  o.prevClip = frame.prevViewProjNoJitter * vec4f(p, 1.0);
  // Facing up and outward, so a tuft catches the light as a clump rather than
  // as three separate slivers.
  o.normal = normalize(normal + vec3f(dir.x, 1.2, dir.y) * 0.6);
  // Olive and muted, near the seabed's own colours: bright green turf reads as
  // plastic against sand.
  let green = mix(vec3f(0.19, 0.29, 0.13), vec3f(0.31, 0.38, 0.16), bh.z);
  let weed = mix(vec3f(0.28, 0.31, 0.14), vec3f(0.17, 0.32, 0.25), h.w);
  o.tint = mix(green, weed, m.a) * (0.8 + 0.3 * bh.y);
  o.along = up;
  return o;
}

struct FOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
};

@fragment
fn fs(i: VOut) -> FOut {
  var s = defaultSurface();
  // Darker at the base, where a tuft shades itself.
  s.albedo = i.tint * (0.55 + 0.45 * i.along);
  s.normal = normalize(i.normal);
  s.roughness = 0.9;
  s.ao = 0.5 + 0.5 * i.along;
  s.f0 = 0.02;
  s.translucency = 0.35;
  s.albedo = setDressing(s.albedo);
  let lit = recede(shadeSurface(s, i.world, -1.0), i.world);
  var o: FOut;
  o.color = vec4f(applyWater(lit, i.world), 1.0);
  o.velocity = screenVelocity(i.curClip, i.prevClip);
  return o;
}
`;

/** Turf and weed scattered thickly around the camera. */
export async function createGroundCover(
  device: GPUDevice,
  globalsLayout: GPUBindGroupLayout,
  targets: {
    color: GPUTextureFormat;
    velocity: GPUTextureFormat;
    depth: GPUTextureFormat;
  },
  quality: Quality,
): Promise<RenderSystem> {
  const module = createShader(device, 'cover:shader', shader);
  const localLayout = device.createBindGroupLayout({
    label: 'cover:local-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: {type: 'uniform', minBindingSize: 16},
      },
    ],
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'cover:pipeline',
    layout: device.createPipelineLayout({
      label: 'cover:pipeline-layout',
      bindGroupLayouts: [globalsLayout, localLayout],
    }),
    vertex: {module, entryPoint: 'vs'},
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [{format: targets.color}, {format: targets.velocity}],
    },
    // Blades are thin: seen from either face.
    primitive: {topology: 'triangle-list', cullMode: 'none'},
    depthStencil: {
      format: targets.depth,
      depthWriteEnabled: true,
      depthCompare: 'greater',
    },
  });
  const uniform = device.createBuffer({
    label: 'cover:uniform',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    label: 'cover:bind-group',
    layout: localLayout,
    entries: [{binding: 0, resource: {buffer: uniform}}],
  });

  // A smaller patch on phones: the cost is per blade on screen, and they have
  // fewer pixels to spend.
  const grid = quality.detail ? GRID : Math.round(GRID * 0.7);
  const radius = (grid * CELL) / 2 - CELL * 2;
  const data = new Float32Array(4);

  return {
    name: 'cover',
    update(ctx: FrameContext) {
      const view: CullView = ctx.view;
      // Snapped to the grid so tufts stay put as the camera moves.
      // Cell indices, not metres: the shader identifies a cell by these, and
      // an integer survives the grid sliding under the camera exactly.
      data[0] = Math.floor(view.camPos[0] / CELL) - grid / 2;
      data[1] = Math.floor(view.camPos[2] / CELL) - grid / 2;
      data[2] = CELL;
      data[3] = radius;
      device.queue.writeBuffer(uniform, 0, data);
    },
    drawOpaque(pass: GPURenderPassEncoder) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, bindGroup);
      pass.draw(BLADE_VERTS, grid * grid, 0, 0);
    },
  };
}
