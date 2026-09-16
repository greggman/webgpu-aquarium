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
const CELL = 0.3;
/** Vertices per tuft: five blades of two triangles each. */
const BLADE_VERTS = 30;

const shader = /* wgsl */ `
${surfaceLib}

struct Cover {
  /** Grid origin in world space, and the cell size. */
  origin: vec2f,
  cell: f32,
  radius: f32,
};
@group(1) @binding(0) var<uniform> cover: Cover;

fn hash2(p: vec2f) -> vec4f {
  var q = vec3f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)), dot(p, vec2f(419.2, 371.9)));
  q = fract(sin(q) * 43758.5453);
  let w = fract(sin(dot(q.xy, vec2f(12.9898, 78.233))) * 43758.5453);
  return vec4f(q, w);
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
  let gx = f32(ii % ${GRID}u);
  let gz = f32(ii / ${GRID}u);
  let cellPos = cover.origin + vec2f(gx, gz) * cover.cell;
  let h = hash2(cellPos);
  let xz = cellPos + (h.xy - 0.5) * cover.cell * 0.9;

  let g = groundAt(xz);
  let m = maskAt(xz);
  let normal = normalize(vec3f(g.g, sqrt(max(1.0 - g.g * g.g - g.b * g.b, 0.0)), g.b));
  let base = vec3f(xz.x, g.r, xz.y);

  // Thinner with distance, and gone before the edge of the patch, so nothing
  // ever pops into being in view.
  let dist = distance(base, frame.camPos);
  let fade = smoothstep(cover.radius, cover.radius * 0.72, dist);
  // Turf takes to sand and reef flats, not to bare rock or a wall, and it
  // grows in patches: a slow field decides where there is any at all, so the
  // floor reads as meadow and clearing rather than an even sprinkle.
  let sand = (1.0 - m.r) * (0.4 + m.g * 0.5 + m.b * 0.9);
  let flat = smoothstep(0.62, 0.86, normal.y);
  let meadow = smoothstep(0.25, 0.7, hash2(floor(xz * 0.18)).x + 0.4);
  let grow = fade * flat * step(h.z, (0.25 + sand * 0.75) * meadow);

  let blade = vi / 6u;
  let corner = vi % 6u;
  let bh = hash2(cellPos + vec2f(f32(blade) * 7.3, f32(blade) * 3.1));
  // Two triangles per blade: a tapered strip from the ground to the tip.
  let up = f32(corner == 1u || corner == 2u || corner == 4u);
  let side = f32(corner == 0u || corner == 1u || corner == 5u) * 2.0 - 1.0;

  let lean = bh.x * 6.2831853;
  let dir = vec2f(cos(lean), sin(lean));
  // Short and broad, like turf: tall thin blades read as scattered sticks.
  let height = (0.09 + bh.y * 0.16) * grow;
  let width = (0.02 + bh.z * 0.025) * (1.0 - up * 0.7);

  // Current: the tips stream, the bases hold.
  let phase = frame.time * 1.4 + dot(xz, vec2f(0.4, 0.3)) + f32(blade);
  let sway = (sin(phase) * 0.25 + 0.55) * up * up * height;

  var p = base;
  p += vec3f(dir.x, 0.0, dir.y) * bh.w * 0.09;
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
  let green = mix(vec3f(0.26, 0.44, 0.17), vec3f(0.46, 0.58, 0.22), bh.z);
  let weed = mix(vec3f(0.42, 0.46, 0.18), vec3f(0.24, 0.48, 0.38), h.w);
  o.tint = mix(green, weed, m.a) * (0.8 + 0.35 * bh.y);
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
  let lit = shadeSurface(s, i.world, -1.0);
  var o: FOut;
  o.color = vec4f(applyWater(lit, i.world), 1.0);
  o.velocity = (i.curClip.xy / i.curClip.w - i.prevClip.xy / i.prevClip.w) * vec2f(0.5, -0.5);
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
  const grid = quality.tierIndex >= 2 ? GRID : Math.round(GRID * 0.7);
  const radius = (grid * CELL) / 2 - CELL * 2;
  const data = new Float32Array(4);

  return {
    name: 'cover',
    update(ctx: FrameContext) {
      const view: CullView = ctx.view;
      // Snapped to the grid so tufts stay put as the camera moves.
      data[0] = Math.floor(view.camPos[0] / CELL - grid / 2) * CELL;
      data[1] = Math.floor(view.camPos[2] / CELL - grid / 2) * CELL;
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
