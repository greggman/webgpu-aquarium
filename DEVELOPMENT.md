# Development

## Running

```sh
npm install
npm start          # build in watch mode and serve on http://localhost:8080/
```

Other scripts:

| Command | What it does |
|---|---|
| `npm run build` | Production build into `dist/` |
| `npm run serve` | Serve `dist/` with express |
| `npm run lint` / `npm run fix` | gts lint / auto-fix |
| `npm run typecheck` | TypeScript type check |
| `npm run unit` | Unit tests (math, struct layout, RNG, play area) |
| `npm test` | Build, unit tests, and the puppeteer smoke test |
| `npm run shots` | Screenshots for visual review (`--help` for options) |
| `node test/perf.mjs` | GPU/CPU frame times at 1080p across `--seeds` and `--cameras` |
| `node test/bench.mjs` | Uncapped cost per render, and per system (disables them one at a time) |
| `node test/reduce.mjs a.wgsl b.wgsl` | Runs Safari once per candidate shader, swapped in for the fish shader via `?wgsl=`, and counts NaN texels in the scene buffer (see `bugs/webkit-discard.md`) |

## Controls

| Input | Action |
|---|---|
| Click, then mouse | Look (pointer lock) |
| W A S D / arrows | Swim |
| Space / E, C / Q | Up, down |
| Shift | Swim faster |
| Touch: left side | Virtual stick to swim |
| Touch: right side | Drag to look; two fingers drag vertically for up/down |
| Gamepad | Left stick swim, right stick look, triggers up/down, bumper faster |

The button in the top right generates a new ocean (a fresh random seed).

The auto camera swims alongside one creature at a time (a school, a ray, a
jellyfish, a reef fish), and every 10–15 seconds glides over to another one
nearby. Any input hands control to you; it picks back up after 5 seconds
without input. The camera is kept inside the part of the basin
that was designed to be seen: a current gently pushes you back near the edges.

## URL parameters

| Parameter | Example | Meaning |
|---|---|---|
| `seed` | `?seed=42` | World seed (random if omitted; shown in the HUD) |
| `quality` | `?quality=mobile` | `mobile`, `medium`, `high`, `ultra` (auto-detected otherwise) |
| `style` | `?style=golden-hour` | Force a water style: `tropical`, `lagoon`, `deep-blue`, `kelp-forest`, `golden-hour` |
| `camera` | `?camera=reef` | Start at a preset: `reef`, `kelp`, `wide`, `overhead`, `surface` (disables the tour) |
| `time` | `?time=20` | Start time in seconds |
| `paused` | `?paused=1` | Start paused (for deterministic captures) |
| `profile` | `?profile` | Show frame timing HUD |
| `profile=gpu` | `?profile=gpu` | Also list triangles and draw calls per system, and GPU time per pass (per-pass times are not meaningful on tile-based Apple GPUs, which defer all the work to the end of the frame) |
| `hud` | `?hud=0` | Hide the HUD |
| `scale` | `?scale=1` | Fixed render scale (disables dynamic resolution); the high tier renders at 0.8 and upscales |
| `disable` | `?disable=volumetrics,ssao` | Drop render systems or effects (profiling) |
| `only` | `?only=fish` | Keep only the named render systems, on black (bisecting a drawing fault) |
| `watch` | `?watch=1` | Read the scene buffer back every 12 frames and log NaN, Inf and absurdly bright texels |
| `wgsl` | `?wgsl=fish:render-shader=/x.wgsl` | Compile the WGSL at that URL in place of the shader with that label (labels: `__aquarium.shaders`); repeatable. For reducing a driver fault with `node test/reduce.mjs` |

## How it works

- **Seafloor**: a compute shader builds a basin heightfield (dunes, outcrops, a
  ring of cliffs with a gap into deep water), then normals, horizon-based AO and
  material masks. The data is read back for placement and the play area.
- **Meshes**: rocks, coral, anemones, urchins, starfish, shells, seahorses,
  kelp, sea fans, fish and jellyfish are parametric patches evaluated by one
  generic GPU mesh builder (`src/gen/meshgen.ts`).
- **Fish**: each seed invents species (body shape, fins, pattern, behaviour)
  and fills the basin with 10–20 thousand of them in schools. A compute shader
  steers each school's leader (terrain, rocks, camera, darting, curiosity) and
  every other fish holds a slot in its leader's formation, so the cost per fish
  is constant. A second compute pass culls fish to the view and picks one of
  three mesh detail levels, feeding indirect draw calls.
- **Light**: per-channel absorption and scattering, animated compute caustics
  from the Jacobian of refracted surface waves, a texel-snapped sun shadow map,
  volumetric shafts raymarched at reduced resolution, Snell's window.
- **Post**: SSAO, TAA, depth of field, bloom, AgX tone mapping and a per-style
  colour grade.
- **Quality tiers** scale resolution, shadow size, volumetric steps and content
  density; dynamic resolution holds the frame-rate target.

## Development notes

- Every WebGPU object is labelled; in all builds an unlabelled object is reported
  as an error. `uncapturederror` messages go to the console, the on-screen
  overlay and `window.__aquarium.errors`.
- `window.__aquarium` exposes `ready`, `errors`, `frame`, `setCamera`,
  `setTime`, `step(seconds, frames)` and `pause` for tests.
- Visual quality is reviewed by the `aaa-judge` agent
  (`.claude/agents/aaa-judge.md`); verdicts are logged in `JUDGING.md`.
