# AAA Judge Log

Verdicts from the `aaa-judge` agent (see `.claude/agents/aaa-judge.md`), newest last.

## Review 1 — commit c168893 — FAIL (avg 4.6)

Evidence: seeds 1–3 × reef/wide/kelp/overhead, high tier, 1080p, 2-frame sequences.

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 5 |
| 2 | Water medium | 5 |
| 3 | Caustics | 6 |
| 4 | Materials | 3 |
| 5 | Geometry & silhouettes | 4 |
| 6 | Life & animation | 4 |
| 7 | Composition, grade & mood | 4 |
| 8 | Variety across seeds | 5 |
| 9 | Technical artifacts | 5 |

Biggest gaps (ranked):
1. Monochrome cyan wash, no saturated near-field colour, no depth darkening.
2. Rock/coral surfaces read as untextured blobs; faceted silhouettes.
3. Almost no visible fish life; no readable schools.
4. Light shafts are an even comb of streaks with herringbone aliasing.
5. Kelp reads as a bamboo plantation (straight rods, grid, cloned bulbs, no canopy).
6. Caustics look like a swimming pool; streak on steep faces; too strong from overhead.
7. Props are not grounded (no contact occlusion).
8. Seeds 1 and 2 look too alike.

What works: temporal stability, animated chromatic caustics, smooth fog, dappled kelp light, seed 3's blue grade, jellyfish translucency, ray shadow.

## Review 2 — commit 94f207b — FAIL (avg 5.2)

Evidence: seeds 1–4 × reef/wide/kelp/overhead, high tier, 1080p, 2-frame sequences.

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 6 |
| 2 | Water medium | 6 |
| 3 | Caustics | 6 |
| 4 | Materials | 4 |
| 5 | Geometry & silhouettes | 4 |
| 6 | Life & animation | 5 |
| 7 | Composition, grade & mood | 5 |
| 8 | Variety across seeds | 6 |
| 9 | Technical artifacts | 5 |

Biggest gaps (ranked):
1. Rocks read as faceted pyramids with glossy marbled Voronoi cells instead of porous, layered, encrusted reef rock.
2. The reef is dominated by one tube-coral generator; plates look like lily pads.
3. Kelp still reads as bamboo: needs wavy leaning stipes, wide ruffled blades, a surface canopy, fish.
4. Shafts: hard-edged background columns with moiré; blowout in one seed; no occlusion gaps.
5. Life too small and far: needs hero fish within 2–4 m and fish in the kelp.
6. Seeds 1 and 3 water grades too flat (cyan wash / green soup).
7. Composition: reef centred on flat sand; frame against open blue or rock walls.
8. Caustics smear on steep faces and look like a pool from above; black hole under table coral.

Already addressed after this capture (before review 3): terrain pinnacles removed, smooth
terrain cap, DOF with depth-buffer autofocus, clearer lagoon/kelp styles.

## Review 3 — commit 7ffc0c0 — FAIL (avg 5.4)

Evidence: seeds 1–4 × reef/wide/kelp/overhead/surface, high tier, 1080p, 1-frame sequences.

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 6 |
| 2 | Water medium | 6 |
| 3 | Caustics | 6 |
| 4 | Materials | 4 |
| 5 | Geometry & silhouettes | 5 |
| 6 | Life & animation | 6 |
| 7 | Composition, grade & mood | 5 |
| 8 | Variety across seeds | 6 |
| 9 | Technical artifacts | 5 |

Biggest gaps (ranked):
1. Materials read as toys and clay: plastic fish, plasticine sponges, plastic table plates, flat card kelp.
2. Kelp forest is an orchard of paper cutouts: no canopy, sawtooth blade edges, no fish, camera clipping blades.
3. Every scene is one coral clump on flat rippled sand: needs reef walls, overhangs, drop-offs, channels, slopes.
4. Shafts only good in seed 4 (slanted): others are vertical combs or flat-bottomed bars with banding.
5. Seeds 1 and 3 are green soup; near-field sand is mint.
6. Surface view is cartoonish: hard ripples, no sky, flat teal outside Snell's window.
7. Caustics blow out on slopes and look like a pool from above.

What works: seed 4 reef/wide mood, sand caustics, seed 2 blue fade, dappled kelp shadows, gentle DOF,
branching coral silhouettes, hero fish and schools with tail motion, sunburst in surface shots, stability.
