# WebGPU Aquarium

A procedurally generated underwater world rendered with WebGPU. Every run grows a
new reef: terrain, rocks, coral, plants, creatures and fish species are all
generated from a seed, mostly in GPU compute shaders.

[Live](https://greggman.github.io/webgpu-aquarium)

<img src="screenshots/screenshot-01.png">

## How compute shaders are used

Compute shaders are used in two places. At load time they build the world:
textures, terrain and every procedural mesh. Every frame they run the fish
simulation and three lighting effects.

### Load time: building the world

**1. Detail texture**: [textures.ts](src/gen/textures.ts)
- One 8×8-workgroup pass writes a tileable 512² `rgba16float` storage texture,
  with a different pattern in each channel:
  - R: broad fbm noise
  - G: rock cells and cracks from Worley F2−F1 noise
  - B: warped sand ripples
  - A: fine grain
- Mips are then built with render passes (`MipGenerator`), not compute.
- Nearly every surface samples this texture, and the volumetrics use its R
  channel to break the light shafts into groups.

**2. Terrain heightfield**: [terrain.ts](src/gen/terrain.ts). Two passes run one
after the other through the `dispatch2D` helper in [util.ts](src/gpu/util.ts).
- **Generate:** `basinHeight()` builds the basin with fbm, a ridged cliff rim,
  strata ledges and a gap that drops into the deep. A smooth-min cap keeps the
  terrain from ever breaking the water surface.
- **Derive:** reads the heights and computes, per texel:
  - normals by central differences
  - horizon-based AO: 8 directions × 7 exponentially spaced taps
  - curvature (a Laplacian) to separate rock ridges from sandy hollows
  - biome masks for rock, reef, kelp and moss, including the spur-and-groove reef
- The results go to storage textures for rendering and to buffers that are
  **read back to the CPU**. The CPU copy is used to place props, find ground
  height for the camera, and so on.
- **Verify:** a small 32×32 compute pass (`verifyHeightTexture`) reads the
  height texture back and compares it with the CPU copy. This catches a device
  that wrote one but not the other, which would leave props floating in
  mid-water.

**3. Procedural meshes**: [meshgen.ts](src/gen/meshgen.ts)
- This is the main mesh builder. Rocks, coral, plants, critters, jellyfish and
  fish are all described as parametric (u, v) patches.
- Each kind supplies its own WGSL `surface()` function, which is spliced into
  the builder shader. So there is effectively one compute pipeline per kind, and
  each one evaluates every vertex of every patch of every variant in **a single
  dispatch**.
- Normals come from finite differences unless the surface function supplies one.
- The dispatch is laid out as a 2D grid of 8192-vertex rows, so large vertex
  counts stay under the per-dimension workgroup limit.
- The CPU only builds the index lists. The level-of-detail chains
  (`withLodChain`) are the same surfaces run with fewer segments.

**4. Volumetric terrain**: [voxel.ts](src/gen/voxel.ts). This is optional,
enabled with `?terrain=voxel`. The seabed becomes a 3D density field, which
allows overhangs and tunnels, and is meshed with surface nets entirely on the
GPU. Each 32³ chunk runs three passes:
- `density_main` (4×4×4 workgroups) samples the field: the height map as a
  baseline, plus leaning walls and carved tunnels.
- `vertices` places one vertex in each cell the surface crosses, using a Newton
  step from the cell centre rather than the usual average of edge crossings,
  which avoids a quilted look. Output slots are claimed with `atomicAdd` into
  shared vertex and index buffers.
- `quads` emits a quad for each grid edge where the field changes sign, again
  allocating with atomics.
- After each chunk, `copyBufferToBuffer` snapshots the running counters, which
  gives that chunk's index range for culling later.
- A final `top_main` pass marches down each column of a 512² grid to find the
  top of the rock, then refines it with bisection. It is read back so plants and
  the camera stand on the real surface rather than on the height map.
- `reportVertexError` reads vertices back as a self-check against the height map.

### Every frame

**5. Fish simulation**: [fish.ts](src/sim/fish.ts)
- This covers 10–20k fish, one thread each (workgroup size 64), using ping-pong
  buffers (`simGroups[flip]`).
- **Leaders** return toward a home point, which can roam, then wander and keep a
  cruise speed.
- **Followers** hold a hashed slot in their leader's formation, which drifts
  slowly so the school "breathes".
- **All fish** also get:
  - a height band above the ground, with look-ahead so they swim along steep
    walls instead of climbing them
  - rock avoidance
  - fear of the camera, or for curious species, a spot a few metres in front of
    the lens
  - occasional darting
- The same pass writes the render instance data: a quaternion built as
  yaw·pitch·bank (so it can't go skew or NaN), plus the previous position and
  rotation for motion vectors and TAA.
- Large frame times are split into up to 4 substeps, each submitted separately
  because it needs different uniform contents.

**6. GPU culling and LOD**: [fish.ts](src/sim/fish.ts) (`cullWgsl`)
- A pass over every fish does distance and frustum-side-plane culling, then
  picks one of 3 LODs from the projected size in pixels.
- Survivors are sorted into buckets per species and LOD with `atomicAdd`,
  writing fish indices into a `visible` list.

**7. Indirect-args fill**: [fish.ts](src/sim/fish.ts) (`indirectWgsl`)
- A tiny pass copies the bucket counts into the `instanceCount` fields of the
  `drawIndexedIndirect` args, two draws per bucket (body and fins).
- Visible fish are drawn without the CPU ever learning how many there are.

**8. Caustics**: [caustics.ts](src/render/caustics.ts)
- Evaluates 12 surface waves, then computes intensity as 1/|det J| of the
  refraction mapping's Jacobian. That is what produces the bright focal lines.
- The three colour channels use slightly different displacement strengths
  (alpha ×0.94, ×1, ×1.06), which gives chromatic fringes.
- The texture is 256–1024² depending on quality tier and is refreshed every
  frame or every other frame (`causticsStride`), followed by a mip rebuild.
- The volumetrics read the 1×1 mip as the pattern's average brightness.

**9. Volumetric light shafts**: [volumetrics.ts](src/render/volumetrics.ts)
- A raymarch at 1/2 to 1/4 resolution, depending on tier, with jitter and more
  samples near the camera.
- Each sample is lit by the shadow map and by the caustic texture at the point
  where its sunlight entered the water, which is what turns uniform haze into
  god rays.
- It also does its own temporal accumulation, reprojecting into a ping-ponged
  history texture, and packs view distance into alpha.
- A fragment-shader composite then upsamples it with depth-aware weights.

**10. SSAO**: [ssao.ts](src/render/ssao.ts)
- A half- or third-resolution pass rebuilds view-space positions from depth. It
  takes normals from whichever neighbour has the smaller gradient, to avoid
  smearing across edges.
- It takes 12 spiral taps, rotated per frame, and packs AO and depth into an
  `rgba8unorm` storage texture.
- A fragment-shader composite blurs it with depth-aware weights.

### Deliberately not compute

Particles and ground cover are **stateless**: they are recomputed in the vertex
shader from hashes and time, with no simulation buffers. Mip generation, bloom,
depth of field, TAA and autofocus are all render passes; autofocus renders a
small depth patch and reads it back.

### Common patterns

- 8×8 workgroups for anything 2D, 4×4×4 for voxels, and 64 in 1D for per-fish
  work.
- The early-return bounds check `any(id >= size)` appears in every shader.
- `createComputePipelineAsync` is used almost everywhere.
  [device.ts](src/gpu/device.ts) wraps both pipeline-creation calls and pass
  encoding for error reporting and profiling
  ([profiler.ts](src/gpu/profiler.ts) times compute passes).
- Atomics are used as allocators (voxel mesher, fish cull buckets) rather than a
  prefix sum.
- Load-time passes often read their results back to the CPU (terrain, voxel top
  surface), because CPU-side placement and collision need the same answer the
  GPU drew.

## LICENSE: [MIT](LICENSE.md)
