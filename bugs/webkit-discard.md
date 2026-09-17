# A fragment shader with two `discard`s leaves NaN in the colour attachment

**Safari 26.6.2, macOS 26.6.2, Apple silicon.** Chrome on the same machine is
clean. Firefox shows the same visible symptom (untested with the flag below).

## Symptom

A fragment shader that writes **one constant colour** and discards some of its
pixels leaves NaN texels in the colour attachment — inside the drawn object,
interleaved with texels holding the constant. Bloom then spreads each one into
a visible block.

Every texel must be either the clear value or that constant:

- no fragment covered it → clear value;
- a fragment covered it and discarded → per WGSL, the fragment shader stage
  output is not written to any render target;
- a fragment covered it and returned → the constant.

NaN is none of those. Note WGSL zero-initialises function-scope `var`, so an
uninitialised output struct would give zeros, not NaN; initialising the outputs
before the discards explicitly makes no difference either.

## Reproduction

Live, one flag apart (needs a build at or after `d6999d0`):

```
FAILS: https://greggman.github.io/webgpu-aquarium/?only=fish&fishcut=both&watch=1
CLEAN: https://greggman.github.io/webgpu-aquarium/?only=fish&watch=1
```

`fishcut=both` restores two `discard` statements the fish shader used to have;
nothing else differs. `watch=1` reads the scene buffer back and puts the NaN
count on screen. Roughly 6,000 NaN texels over 14 s versus 0.

Locally, `node test/safari.mjs 14 seed=221315123 only=fish fishcut=both
disable=fish-blobs` drives Safari over WebDriver and prints the counts
(`safaridriver --enable` once first).

## The shader

`fish:render-shader`, the only one that fails. It is assembled from chunks at
runtime, so the file has no single readable copy — get the exact WGSL that
compiled with:

```js
await __aquarium.ready;
copy(__aquarium.shaders['fish:render-shader']);   // devtools console
```

Where the pieces live:

| | |
| --- | --- |
| fragment entry `fn fs` | `src/sim/fish.ts:1443` |
| shader assembled | `src/sim/fish.ts:1283` (`renderWgsl`) |
| discard 1, near-lens dissolve | `src/sim/fish.ts:1478` |
| discard 2, fin webbing, inside the fin branch | `src/sim/fish.ts:1575` |
| lighting, `shadeSurface` | `src/shaders/lighting.wgsl:130` |
| fog, `applyWater` — the failing branch is the `far > 0.0` one | `src/shaders/water.wgsl:64` |
| `waterBackground` → `surfaceFromBelow` → `skyRadiance` | `src/shaders/water.wgsl:82`, `:119`, `:104` |

Both discards are compiled out entirely unless `?fishcut=both` is set; that
flag is the only difference between the two URLs above.

## Reduction

Each line is the whole fish shader with one thing changed:

| shader | result |
| --- | --- |
| both discards, unchanged | **~6,000 NaN texels / 14 s** |
| either discard alone | clean |
| both discards, output forced to a constant (shading dead) | clean |
| both discards, material built, nothing lit | clean |
| both discards, material + full lighting | clean |
| everything except the final fog call | clean |
| fog, without its distance branch | clean |
| that branch calling a shallow function of the same shape | clean |
| that branch calling the real one (sky, refraction, waves) | **FAILS** |

So it needs **two discards** *and* the whole shader's complexity. One discard
is always fine, which is why ordinary alpha-tested transparency is unaffected.
The shading must also be live — with it dead-code-eliminated, it is clean.

## Ruled out

Not the arithmetic: with outputs forced to a constant, every derivative
removed, and outputs initialised before the discards, the NaN texels still
appear. Not uniformity: the shader passes WGSL's static uniformity analysis in
all three implementations, so no derivative is in non-uniform control flow.
Not post-processing: the NaN is in the scene buffer before any of it runs.

`bugs/webkit-discard.html` is a standalone page of 13 configurations that all
**pass**, in Safari and Chrome — listed so nobody re-treads them:

1 and 2 colour attachments; `rgba16float` and `rgba8unorm`; a depth attachment
with reversed Z; 200 overlapping instances; `drawIndirect` and
`drawIndexedIndirect`; a discard pattern reseeded every frame; flat varyings
and `front_facing`; a storage-buffer read in the fragment; implicit- and
explicit-LOD texture sampling; two discards, sequential, nested in a
non-uniform branch, and in mutually exclusive branches; heavy live arithmetic
between them; and the renderer's own ~180-line fog chain (noise, waves,
absorption, in-scattering, Snell's window, sky through refraction)
transplanted verbatim with the discard count as the only variable.

Constructing upward and transplanting downward both fail to reproduce it, which
points at a threshold in shader complexity or control-flow lowering rather than
any construct that can be shown on its own. Hence the live build above as the
reproduction.
