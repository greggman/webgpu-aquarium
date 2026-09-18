# A fragment shader with two `discard`s and a few loops leaves NaN in the colour attachment

**Safari 27.0 on macOS 27.0, Apple silicon** (first seen on Safari 26.6.2 /
macOS 26.6.2). Chrome on the same GPU is clean in every case below.

## Minimal reproduction

`bugs/webkit-discard.html` is a standalone page. It draws 300 instanced
blobs (96 triangles each) into a 512×512 `rgba16float` attachment cleared to
black, no depth attachment, no blending, 60 frames, and reads the attachment
back after each frame. The fragment shader writes one finite colour and
discards some fragments, so every texel must be the clear value or a finite
colour. NaN texels are painted magenta in the worst frame's image.

Safari, default settings, one run:

| fragment shader | bad frames | NaN texels |
| --- | --- | --- |
| two discards, second nested, then 12 loops in a branch | **51/60** | **695** |
| same, 9 loops | **49/60** | **593** |
| same, 6 loops | 0 | 0 |
| same, no loops | 0 | 0 |
| two discards, second not nested, 12 loops | 0 | 0 |
| one discard (nested), 12 loops | 0 | 0 |
| two discards, second nested, 12 loops not in a branch | 0 | 0 |
| two discards, second nested, 12 loops, discards after the loops | 0 | 0 |

Chrome (headless, same machine): 0 in every row.

The failing fragment shader, exactly as the page generates it (the vertex
stage just places the instances):

```wgsl
struct U {
  viewProj: mat4x4f,
  camPos: vec3f,
  frameIndex: u32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> instances: array<vec4f>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec4f,
};
struct FOut {
  @location(0) color: vec4f,
};

@fragment
fn fs(i: VOut) -> FOut {
  var o: FOut;
  o.color = vec4f(0.0, 0.0, 0.0, 1.0);
  if (fract(i.pos.x * 0.37 + f32(u.frameIndex) * 0.11) > 0.9) {
    discard;
  }
  if (i.uv.w > 0.5) {
    if (fract(i.pos.y * 0.29 + f32(u.frameIndex) * 0.07) > 0.6) {
      discard;
    }
  }
  let toP = i.world - u.camPos;
  let dir = toP / max(length(toP), 1e-4);
  var c = vec3f(0.5);
  if (dir.y > 0.0) {
    var p = dir.xz * 40.0;
    var sum = 0.0;
    // This block, 12 times over (9 is enough; 6 is clean):
    for (var k = 0; k < 3; k++) {
      sum += p.x * 0.001;
      p = p * 2.0 + 1.0;
    }
    c = vec3f(sum);
  }
  o.color = vec4f(c, 1.0);
  return o;
}
```

What matters, each established by changing one thing:

- **Two `discard`s, and the second one inside an `if`.** Either alone is
  clean. Both unconditional is clean. The nesting condition can be a varying
  (as above) or a uniform that is always true: still fails.
- **The discards come before the loops.** Same loops with the discards moved
  after them: clean.
- **The loops are inside a branch.** Its condition can be non-uniform (as
  above) or a uniform that is always true. Without the branch: clean, even
  with 48 loops.
- **Enough loops.** 9 fail, 6 are clean; 24 loops of one iteration each also
  fail. They can be empty of anything interesting. The same number of `if`
  blocks instead of loops (48 tried): clean. 3,000 lines of straight-line
  `sin`/`cos` instead: clean. Loops in a function called from the branch, or
  inline in it: same result.
- **More than a few primitives.** 10 instances fail (weakly), 300 fail
  strongly; 1 or 4 instances are clean, however large. No depth attachment is
  needed, nor a second colour target; adding either (`?depth=1`, `?mrt=1`, the
  renderer has both) changes nothing.

What does not matter, all tried while reducing: the hash used to decide each
discard (trivial `fract` is as good as interleaved gradient noise), texture
sampling, derivatives, integer arithmetic (including guarded `%` and `/`),
storage-buffer reads in the fragment, the varyings involved, and the amount of
arithmetic. The count of NaN texels per frame is stable for a given shader;
their positions are not, and they sit inside the drawn objects, interleaved
with texels holding the expected colour.

Knobs on the page, as URL parameters: `?frames=`, `?instances=`, `?scale=`,
`?w=&h=`, `?mrt=1`, `?depth=1`, `?only=<substring of a row name>`. The page
sets `window.__result` when done.

## In the renderer

The fish shader used to have two discards: a near-lens dissolve
(`src/sim/fish.ts`, `wantDissolve`) and stochastic fin webbing, inside the
fin branch (`wantFin`). Both are compiled out unless `?fishcut=both` is set.
That shader's colour goes through `applyWater`, whose far branch calls
`waterBackground` → `surfaceFromBelow`, which has three wave loops and four
`fbm2` noise calls of three octaves each: the loops. With `?fishcut=both`
the scene buffer gets ~15 NaN texels per frame at 900×648; bloom then
spreads each one into a visible block.

Frozen reproduction in the app, same frame every run (fish paused, camera
fixed, no dynamic resolution; only the per-frame discard pattern and the NaN
positions change):

```
?only=fish&fishcut=both&seed=221315123&camera=reef&paused=1&time=0&scale=1&hud=0
```

and `?watch=1` logs the NaN count.

## How it was reduced

`?wgsl=fish:render-shader=<url>` compiles a WGSL file in place of the
assembled fish shader, and `node test/reduce.mjs a.wgsl b.wgsl ...` runs
Safari once per candidate against the frozen configuration above and counts
NaN texels over 30 frames; a candidate takes about eight seconds. Starting
from the shader as compiled (`__aquarium.shaders['fish:render-shader']`,
1,072 lines), each step kept the whole shader and changed one thing; a step
that stayed at ~15 NaN per frame was kept. The ladder:

| whole fish shader, fragment stage reduced to | result |
| --- | --- |
| as compiled (both discards) | fails, ~20 NaN/frame |
| either discard alone | clean |
| discards + material + lighting + fog, no fish pattern / no velocity / no derivatives | fails |
| discards + fog only (`applyWater` of a constant) | fails |
| discards + fog without its far branch | clean |
| discards + `waterBackground(dir)` only | fails |
| discards + any one of its callees on its own (`surfaceFromBelow`, `skyRadiance`, `inscatterColor`, waves, `fbm2`) | clean |
| discards + `if (dir.y > 0) { c = surfaceFromBelow(dir) }` | fails |
| same, `surfaceFromBelow` minus its sky | fails |
| same, minus any one of: second wave sample, third wave sample, ripple noise, mottle noise, or noise octaves 3 → 1 | clean |
| same, minus fresnel / refraction / Snell window / in-scatter | fails |
| discards + branch with 3 wave samples + 4 `fbm2` summed, nothing else | fails |
| discards + branch with 8 `fbm2` (no waves) | fails; 4 `fbm2`: clean |
| `fbm2` with hashing and trig removed, only its loop and the early-return helper left | fails |
| that helper called 72 times with no loops | clean |
| discards + branch with 12 bare `for` loops | fails; 6: clean; 9: fails |
| same with the discards after the loops, or without the branch, or second discard not nested, or one discard | clean |

An earlier version of this file, and of the standalone page, concluded that
no construct could reproduce it outside the renderer. That was wrong: the
earlier standalone attempts built upward from a full-screen triangle with
heavy arithmetic, and none of them had loops after a nested discard, nor
more than a couple of primitives.
