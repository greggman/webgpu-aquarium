# WebGPU Aquarium — Implementation Plan

Derived from [DESIGN.md](DESIGN.md). Goal: a procedurally generated, AAA-quality
underwater scene (Horizon Forbidden West / Subnautica 2 tier) in TypeScript + WebGPU,
unique on every run, with an independent "AAA judge" agent gating each milestone.

---

## 1. Toolchain (versions verified against npm, 2026-09-14)

| Package          | Version  | Notes |
|------------------|----------|-------|
| typescript       | `6.0.3`  | **Not 7.x.** typescript-eslint (used by gts) requires `typescript >=4.8.4 <6.1.0`. 6.0.3 is the newest compatible. |
| gts              | `7.0.0`  | Brings eslint 9, typescript-eslint 8, prettier 3. |
| esbuild          | `0.28.2` | Bundles `src/main.ts` → `dist/`. WGSL imported as text (`loader: {'.wgsl': 'text'}`). |
| @webgpu/types    | `0.1.72` | |
| puppeteer        | `25.11.0`| Requires Node ≥ 22.12 (local Node is 24.20). |
| express          | `5.2.1`  | Local static server only. |

No runtime dependencies. Math (vec3/vec4/quat/mat4) and GPU struct layouts are written
in-house (see §3).

`package.json` scripts:
- `build` — `node scripts/build.mjs` (esbuild, minify, sourcemaps, copies `index.html`)
- `watch` — esbuild watch + express server
- `serve` — `node scripts/serve.mjs` (express static on `dist/`, port 8080)
- `lint` / `fix` — `gts lint` / `gts fix`
- `test` — build, then `node test/smoke.mjs`
- `shots` — `node test/screenshots.mjs` (multi-seed/multi-camera captures for the judge)

---

## 2. Repository layout

```
index.html
src/
  main.ts                 entry: init, resize, frame loop
  gpu/
    device.ts             adapter/device, uncapturederror + device.lost handling, error overlay
    label.ts              labeling helpers / conventions
    shader.ts             createShaderModule + getCompilationInfo reporting
    buffers.ts, textures.ts, pipelines.ts
    structs.ts            single-source struct definitions → WGSL text + TS offsets/views
  math/
    vec3.ts, vec4.ts, quat.ts, mat4.ts   small, allocation-free, WebGPU clip space (z 0..1)
  core/
    rng.ts                seeded PRNG (PCG/xoshiro), ?seed= param
    time.ts               real-time and fixed-step (deterministic) clocks
    scene.ts              world graph, instance tables
    quality.ts            tier detection (ultra/high/medium/mobile) + dynamic resolution
  player/
    input.ts              keyboard/mouse (pointer lock), touch (virtual sticks), gamepad
    camera.ts             swim controller: inertia, banking, head bob, collision
    navvolume.ts          allowed play area (SDF) built from generation output
    attract.ts            idle → cinematic spline camera; any input returns control
  gen/                    procedural generation (CPU orchestration, GPU compute)
    noise.wgsl            shared simplex/worley/FBM/domain-warp
    terrain.ts/.wgsl
    rocks.ts, coral.ts, kelp.ts, anemone.ts, urchin.ts, starfish.ts, shell.ts
    fish.ts, ray.ts, seahorse.ts, jellyfish.ts
    textures.ts           reaction-diffusion patterns, detail normals, albedo variation
    scatter.ts            GPU placement (poisson disk, slope/depth/biome rules)
  sim/
    boids.wgsl            schooling fish
    verlet.wgsl           kelp, seagrass, jellyfish tentacles
    particles.wgsl        bubbles, marine snow
  render/
    frame.ts              render graph / pass ordering
    shadows.ts            sun shadow map (cascaded)
    caustics.ts/.wgsl     animated caustics compute
    gbuffer or forward    PBR + underwater medium
    volumetrics.wgsl      froxel light shafts
    surface.wgsl          water surface from below (Snell's window, TIR)
    post/                 taa, bloom, dof, tonemap (AgX), grade, grain
  debug/
    dev.ts                window.__aquarium hooks for puppeteer
scripts/build.mjs, scripts/serve.mjs
test/smoke.mjs, test/screenshots.mjs
.claude/agents/aaa-judge.md
.github/workflows/pages.yml
```

---

## 3. WebGPU conventions ("modern style")

- `navigator.gpu.requestAdapter({powerPreference: 'high-performance'})`; request optional
  features only if present (`timestamp-query`, `float32-filterable`, `rg11b10ufloat-renderable`)
  and fall back cleanly.
- **Error handling**
  - `device.addEventListener('uncapturederror', e => …)` logs `console.error('[WebGPU]', e.error.message)`
    (so puppeteer sees it) **and** shows it in an on-page overlay and pushes it to
    `window.__aquarium.errors`.
  - `device.lost.then(info => …)` reported the same way.
  - Every shader module: `await module.getCompilationInfo()`; print messages with label + line.
  - `createRenderPipelineAsync` / `createComputePipelineAsync` with try/catch that reports the label.
- **Labels on everything**: devices, buffers, textures, views, samplers, bind group layouts,
  bind groups, pipeline layouts, pipelines, shader modules, command encoders, passes,
  query sets. Convention: `system:object:purpose`, e.g. `caustics:compute-pipeline:animate`,
  `fish:storage-buffer:instances`. A lint-able helper (`label('fish', 'instances')`) keeps it uniform.
- Explicit bind group layouts shared across pipelines (no `layout: 'auto'` for anything shared).
- Struct layouts: each uniform/storage struct is declared once in TS (`gpu/structs.ts`) with
  WGSL types; a small helper computes WGSL alignment/size rules, emits the WGSL `struct`
  source that shaders import, and produces typed-array views for writing. At startup (dev
  builds) it checks sizes against the actual bind group's `minBindingSize` so a layout
  mismatch is a validation error, not silent garbage.
- Stay within **WebGPU default limits** for the mobile tier (e.g. storage buffers per
  stage, texture sizes); request higher limits only on desktop tiers when the adapter offers them.
- Pass textures directly where the spec allows instead of creating throwaway views.
- `writeBuffer` for per-frame uniforms; storage buffers + indirect draws for instanced life.
- HDR canvas: `context.configure({toneMapping: {mode: 'extended'}})` where supported, SDR fallback.

---

## 4. Rendering architecture

Everything renders into an HDR `rgba16float` target at a scalable render resolution.

Per frame:
1. **Simulation compute** — boids, verlet (kelp/tentacles), particles, jellyfish pulse.
2. **Caustics compute** — animated caustic texture (wave-normal refraction, or summed
   Voronoi/Worley layers with chromatic offsets per channel).
3. **Shadow pass** — cascaded sun shadow map; instanced and alpha-tested for kelp.
4. **Culling compute** — GPU frustum/distance culling → `drawIndexedIndirect` args, LOD pick.
5. **Opaque pass** — PBR (GGX + Lambert), caustics projected along sun direction and
   attenuated by depth, SSAO or GTAO, cheap subsurface for fins/kelp/coral, iridescence for
   fish scales and shell nacre.
6. **Water medium** — per-channel Beer-Lambert absorption (red dies first), in-scattering
   toward a depth-based ambient color, height fog.
7. **Volumetrics** — froxel grid (or half-res raymarch) of sun shafts that uses the shadow map
   and caustics, with temporal reprojection. This is the biggest single "AAA" signal.
8. **Transparent pass** — jellyfish (fresnel, SSS, bioluminescent emissive), bubbles
   (refraction + fresnel rim), marine snow, water surface from below (Snell's window,
   total internal reflection, animated normals).
9. **Post** — TAA, bloom (dual-filter), DOF with focus on hero subject, subtle chromatic
   aberration, AgX tonemap, color grade LUT, vignette, film grain.

### Performance targets & quality tiers

- **Primary:** 60 fps at 1080p on Apple M-series (tier `high`; `ultra` for bigger GPUs).
- **Fallback:** iPhone-class GPU (Safari, tile-based renderer) via tier `mobile`, aiming for
  a steady 30–60 fps at native-ish phone resolution while still looking good.

| Feature | ultra / high | medium | mobile |
|---|---|---|---|
| Render scale | 1.0 | 0.8 | 0.6–0.75 + TAA upscale |
| Volumetric shafts | froxel grid + temporal | half-res raymarch | screen-space radial shafts masked by caustics/shadow |
| Shadows | 3–4 cascades, 2048² | 2 cascades | 1 cascade, 1024², kelp alpha skipped |
| Caustics | compute, per-channel dispersion | compute, mono | precomputed tiling loop generated once at startup |
| AO | GTAO | half-res SSAO | baked vertex AO from generation |
| DOF / grain / CA | on | DOF off | off |
| Fish / kelp sim | full counts | ~60% | ~30%, lower sim rate |
| Pass count | full | full | merged passes, minimal load/store to suit tile GPUs |

- Tier chosen from adapter info + limits (+ `?quality=` override), then **dynamic
  resolution** adjusts render scale to hold the frame-time target.
- Formats that work everywhere (`rgba16float`, `depth24plus`/`depth32float`); features like
  `float32-filterable` and `timestamp-query` are strictly optional.
- Timestamp queries (when available) feed an on-screen profiler (`?profile`).

---

## 5. Procedural content

All generation is seeded (`?seed=N`; random seed if omitted, shown on screen/in console).
Heavy work runs in compute shaders; CPU only orchestrates and builds topology.

| Content | Technique |
|---|---|
| Seafloor | Compute heightfield: FBM + domain warping, erosion-like ridging, sand ripples along current direction, biome mask (sand / rock / reef / seagrass). Chunked mesh with GPU normals. |
| Rocks | Displaced icospheres (compute), triplanar detail, moss/algae mask by up-facing slope. |
| Coral | Branching (space colonization) → tube meshes; brain coral via reaction-diffusion displacement; plate/table and fan coral (thin membranes w/ SSS); per-colony color palettes. |
| Kelp / seagrass | Ribbon strands simulated with verlet in compute, driven by a current field; translucent blades. |
| Anemones | Column + instanced tentacles with sway shader; clownfish can pick them as home. |
| Urchins | Sphere + thousands of instanced spines (compute-generated orientations). |
| Starfish | Parametric 5-arm (sometimes 6+) profile, bumpy displacement, pattern texture. |
| Shells | Raup's logarithmic-spiral shell model (conch, nautilus, scallop, cowrie variants). |
| Fish | "Genome" per species: spine length, cross-section superellipses along body, fin shapes (membranes with rays), pattern (stripes/spots/gradients via reaction-diffusion/noise), palette. Vertex-shader swimming wave. 5–10 species per seed, boids schools in compute. |
| Rays | Flat diamond body with wing undulation wave, glide path steering. |
| Seahorses | Segmented curled-tail tube with ridges, dorsal fin flutter, anchored to kelp/coral. |
| Jellyfish | Bell mesh with pulse animation, oral arms + verlet tentacles, translucent/emissive. |
| Bubbles | Emitted from vents/rocks, wobble + rise, merge-free particle sim. |
| Marine snow | Camera-relative particle volume, depth-faded. |
| Textures | Compute-generated: detail normals, albedo variation, patterns, caustics. |

Placement: GPU poisson-disk scatter with rules (depth, slope, biome, proximity to reef),
plus composition passes that place hero clusters inside the play area (§5a).

---

## 5a. Controllable camera & play area

A game-style swimming camera that can only go where the scene looks good.

- **Controls**
  - Desktop: WASD + mouse look (pointer lock), Space/C (or Q/E) up/down, Shift to swim faster.
  - Touch (iPhone): left virtual stick moves, right-side drag looks, two-finger vertical drag for up/down.
  - Gamepad: standard mapping via the Gamepad API.
- **Feel**: velocity with inertia and drag, slight roll when turning, gentle bob and drift
  from the current, smoothed look. Feels like a diver or a drone, not a debug fly-cam.
- **Play area** (`navvolume.ts`), generated alongside the world for each seed:
  - The world is generated as a bounded "valley" or reef basin with hero content in the middle;
    the play area is a 3D signed-distance field covering the part that has been art-directed.
  - Floor: keep a minimum height above terrain/coral/rocks (sampled from the heightfield +
    coarse SDF of large props), so the camera never clips inside geometry.
  - Ceiling: stays far enough below the surface for Snell's window to look right, and the
    surface is never reached.
  - Edges: soft boundary. Approaching the edge, a current pushes back, fog thickens, and
    movement slows. There is no invisible wall that stops you dead.
  - Generation ensures nothing ugly is visible from anywhere in the area: edges of generated
    terrain hide behind fog distance and rock walls/drop-offs, and LOD/culling distances are
    set from the maximum view distance inside the area.
- **Attract mode**: after ~20 s idle (and on first load before input), a cinematic spline
  camera tours hero spots inside the play area; any input hands control back smoothly
  from the current pose.
- **Screenshot presets**: named cameras (`?camera=reef`, `kelp`, `overhead`, …) are generated
  per seed from hero cluster locations, so tests and the judge see consistent framing.

---

## 6. Testing & dev loop

- **Server**: `scripts/serve.mjs` — express static serving `dist/`.
- **Dev hooks** (`window.__aquarium`, always present, harmless in prod):
  - `ready: Promise<void>` — resolves after generation finishes and the first frame presents.
  - `errors: string[]` — all WebGPU/validation/shader errors.
  - `setTime(t)`, `setCamera(preset | {pos, target})`, `pause()`, `step(n)` for determinism.
  - URL params: `?seed=`, `?camera=`, `?time=`, `?quality=`, `?profile`.
- **`test/smoke.mjs`** (puppeteer, `puppeteer.launch()` with no special args):
  start the server, load the page, pipe `console`/`pageerror` to stdout, await `ready`,
  render N frames, **fail if `errors` is non-empty**, check the frame isn't blank
  (luminance variance above a threshold).
- **`test/screenshots.mjs`**: for a set of seeds × camera presets × times, capture with
  `element.screenshot()` (compositor path — not `canvas.toDataURL()`, which can read back a
  cleared buffer), plus a short frame sequence per shot for judging motion. Output to
  `screenshots/<run-id>/` (gitignored).
- **Mobile tier testing**: `test/smoke.mjs` also runs with `?quality=mobile` at a phone
  viewport (e.g. 390×844 @3x emulation, touch enabled) and asserts no errors and that the
  device was created with default limits only. Real iPhone/Safari is checked manually
  (puppeteer drives Chrome), and `?profile` output from the phone is used for tuning.
- **Unit tests** (Node, no GPU): math, struct layout rules, RNG determinism, nav-volume
  clamping.
- GitHub Actions runners have no GPU, so CI runs lint + build + unit tests; visual tests are local.

---

## 7. The AAA judge agent

`.claude/agents/aaa-judge.md` — a Claude Code subagent whose **sole duty** is to judge
whether the output matches AAA underwater rendering. It does not write code.

- **Tools**: Read (to view screenshots) and Bash (only to run `npm run shots`).
- **Input**: a fresh screenshot set across ≥3 seeds and several cameras, plus frame sequences.
- **Rubric** (1–10 each, with concrete reference points from Horizon Forbidden West,
  Subnautica 2, etc.):
  1. Lighting & light shafts
  2. Water medium (absorption color, depth falloff, scattering)
  3. Caustics
  4. Materials (SSS, iridescence, wetness, translucency)
  5. Geometry & silhouette detail
  6. Life & animation (schooling, sway, pulse — judged from sequences)
  7. Composition, color grade, and mood
  8. Variety across seeds (does each run feel unique and still beautiful?)
  9. Technical artifacts (aliasing, banding, shadow acne, popping, z-fighting, noise)
- **Output**: per-category scores, overall verdict **PASS / FAIL** (pass = every category ≥ 7,
  average ≥ 8 for final release), and a ranked list of the highest-impact fixes.
- The `mobile` tier is judged separately, with a lower bar (every category ≥ 6). Its
  question is "does the fallback still look intentional and beautiful?", not whether it
  matches desktop.
- The agent is instructed to be harsh and to compare against the reference games, not
  against "good for a browser demo."
- Verdicts are appended to `JUDGING.md` so progress is tracked across milestones.

---

## 8. GitHub Pages release

`.github/workflows/pages.yml`:
- Triggers: push to `main`, plus `workflow_dispatch`.
- Jobs: `actions/checkout` → `actions/setup-node` (Node 24, npm cache) → `npm ci` →
  `npm run lint` → `npm run build` → `actions/upload-pages-artifact` (path `dist`) →
  `actions/deploy-pages`.
- Permissions: `pages: write`, `id-token: write`. Concurrency group to cancel stale deploys.
- Build uses relative asset paths so it works under `/webgpu-aquarium/`.
- Use the latest major version of each action at implementation time.
- One-time manual step: enable Pages → "GitHub Actions" source in repo settings.

---

## 9. Milestones

Each milestone ends with: `npm run lint` clean, `npm test` passing with zero WebGPU errors,
and (from M2 on) an AAA judge review. A FAIL produces fix tasks before moving on.

**M0 — Scaffold**
package.json with pinned versions, tsconfig (strict, ES2022, `@webgpu/types`), gts config,
esbuild script, express server, device init with `uncapturederror`/`device.lost`/overlay,
labeled clear-color frame, `window.__aquarium` hooks, smoke test, Pages workflow,
judge agent definition.

**M1 — Render core**
Math library, struct layout helper, seeded RNG, quality tier detection, input (keyboard/mouse,
touch, gamepad) + swim camera, frame uniforms, HDR target + AgX tonemap, compute noise
library, compute-generated bounded terrain basin, play-area SDF with soft boundary,
PBR forward shading, water absorption/fog.

**M2 — Light & water (the "look")**
Cascaded sun shadows, caustics compute, froxel volumetric shafts, water surface from below
with Snell's window, bloom, TAA. → **Judge #1**: environment alone should already read as
"AAA underwater." Iterate until it does; this carries most of the visual quality.

**M3 — Seafloor life**
Rocks, coral (branching, brain, plate, fan), shells, starfish, urchins, anemones,
kelp/seagrass with verlet sim, GPU scatter + culling + indirect draws, procedural textures.
→ **Judge #2**

**M4 — Fauna**
Fish genome → mesh + pattern, boids schools, rays, seahorses, jellyfish with tentacle sim
and bioluminescence. → **Judge #3**

**M5 — Particles, polish, performance**
Bubbles, marine snow, DOF, color grading, grain, attract-mode camera tours of hero content,
play-area tuning (nothing ugly visible from anywhere), timestamp profiling, perf pass for
60 fps @1080p on M-series, and the `mobile` tier's cheaper paths tuned on a real iPhone.
→ **Final judge** across ≥5 seeds for desktop, plus a separate judge of the mobile tier;
both must PASS.

**M6 — Release**
README (controls, URL params), Pages deploy verified on the live URL.

---

## 10. Risks & open questions

- **TypeScript 7** can't be used until typescript-eslint supports it. Pinned to 6.0.3.
- **Scope**: the art list is large. M2 is prioritized because lighting and the water medium
  matter more to the AAA feel than the number of creature types.
- **Judge subjectivity**: mitigated by a fixed rubric, fixed seeds/cameras, and harsh
  instructions; still, the human's own review is the real final call.
- **Hardware variance**: headless Chrome on macOS uses Metal (real GPU); results on other
  machines may differ, and quality tiers handle this.
- **iPhone**: Safari's WebGPU limits, thermal throttling, and tile-GPU costs can't be
  measured in puppeteer. Every expensive feature therefore gets a cheaper mobile path from the
  start, so it isn't retrofitted at the end. Manual device checks happen at M2, M4, and M5.
- **Play area vs. uniqueness**: random worlds can produce bad-looking areas. Generation
  rejects and regenerates layouts that fail simple checks (hero clusters visible, no bare stretches),
  keeping the seed deterministic.
- **Open**: audio isn't in the design doc, so it isn't planned.

---

## 11. Implementation notes (deviations from this plan)

Recorded as the build progressed, so the plan stays an honest description of the code.

- **`@webgpu/types` dropped**: TypeScript 6's `lib.dom` already ships the WebGPU
  interfaces and conflicts with the package. The few missing flag constants
  (`GPUBufferUsage` etc.) are declared in `src/gpu/webgpu-constants.d.ts`.
- **Struct layouts**: every GPU struct is declared with `defineStruct` (`src/gpu/structs.ts`),
  which emits the WGSL and offsets; sizes feed `minBindingSize` where layouts are explicit.
- **Label enforcement** runs in all builds (cheap wrappers), not just dev builds.
- **Volumetrics** are a reduced-resolution raymarch on every tier (1/2, 1/3, 1/4 resolution
  with 24/18/16/10 steps), not froxels. Shafts come from blurred, contrast-normalised
  caustics gated by drifting noise; a phase floor keeps them visible away from the sun.
- **Placement** runs on the CPU using the GPU-generated terrain data read back once;
  meshes, terrain, textures, caustics and fish simulation stay on the GPU.
- **Kelp and plant sway** is a vertex-shader current field rather than a verlet compute sim.
- **Ambient occlusion**: SSAO (compute, 1/2 or 1/3 resolution) on all tiers plus
  horizon AO baked into the terrain; no GTAO.
- **Profiling**: submit-to-`onSubmittedWorkDone` latency (`?profile`) instead of timestamp
  queries, plus `?disable=system,...` to measure per-system cost.
- **Water styles**: five per-seed looks (tropical, lagoon, deep-blue, kelp-forest,
  golden-hour), forceable with `?style=`.
- **Extra camera preset** `surface` looks up through Snell's window.
- **Play-area layout rejection** (regenerating bad layouts) was not needed: reef clusters are
  chosen by score inside the play area and cameras are placed by searching valid spots.
