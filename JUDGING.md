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

## Review 4 — commit 38b59df — FAIL (avg 5.7)

Evidence: seeds 1–4 × reef/wide/kelp/overhead/surface, high tier, 1080p.

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 6 |
| 2 | Water medium | 6 |
| 3 | Caustics | 6 |
| 4 | Materials | 5 |
| 5 | Geometry & silhouettes | 5 |
| 6 | Life & animation | 6 |
| 7 | Composition, grade & mood | 6 |
| 8 | Variety across seeds | 6 |
| 9 | Technical artifacts | 5 |

Biggest gaps (ranked):
1. Kelp reads as bamboo/willow: needs tall stipes reaching the surface, wide drooping golden blades, a dark canopy, soft veins.
2. Fish still toy-like: faceted bodies, paper fins, fish passing through each other, schools dissolve to dots.
3. Spur ridges read as striped prisms; the coral carpet tiles like cobblestones; no undercuts.
4. Seed 3 green soup, mint near-field sand.
5. Shaft stubs with caps, overhead haze smear, no canopy occlusion.
6. Kelp camera inside a blade / facing terrain.
7. Overhead caustics too contrasty (white web, black ripple bands).

What works: backlit kelp around the sun in the seed 1 surface shot (HFW-adjacent), softer Snell's window with
clouds, seed 4 warm slanted shafts, seed 2 deep-blue mood, dappled kelp shadows, gentle DOF, stability.

## Review 5 — commit de48b63 — FAIL (avg 5.8)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 6 |
| 3 | Caustics | 6 |
| 4 | Materials | 5 |
| 5 | Geometry & silhouettes | 5 |
| 6 | Life & animation | 6 |
| 7 | Composition, grade & mood | 6 |
| 8 | Variety across seeds | 6 |
| 9 | Technical artifacts | 5 |

Biggest gaps (ranked):
1. Kelp still bamboo-like (alternating leaf pairs), no visible canopy; kelp camera inside blades.
2. Fish still toys: flat cards/discs/beans from some angles; need volume, countershading, sheen, see-through fins.
3. Reef lacks structure: needs rock faces above camera height with undercuts and overhangs.
4. Materials: rock needs layered wet encrusted detail; coral polyp texture and tip scattering.
5. Seed 3 khaki/olive grade; milky haze smears in overhead shots.
6. Aliasing on thin blades; moiré on ridge carpet.
7. Caustics read as a white crack web on slopes.

What works: long continuous shafts (seed 4 warm, seed 2 blue) close to HFW; sunbursts through the surface;
velvety sponges; schools, bait ball, fish in kelp; soft sand shadows; gentle DOF; stability; distinct palettes.

## Review 6 — commit 6a0d9d9 — FAIL (avg 5.9)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 6 |
| 3 | Caustics | 6 |
| 4 | Materials | 5 |
| 5 | Geometry & silhouettes | 5 |
| 6 | Life & animation | 6 |
| 7 | Composition, grade & mood | 6 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 5 |

Biggest gaps (ranked):
1. Kelp: willow hedge; needs bare dark lower trunks, one-sided drooping wrinkled blades, dense canopy mat seen from below; camera looking up through trunks.
2. Fish: lacquered spinning tops / lemons / pills; need slimmer bodies (3–5x long), narrow tail stems, satin sheen, set-in eyes.
3. No vertical reef structure; the bommie reads as a mushroom; needs 3–6 m heads with undercuts and shelf ledges.
4. Materials: rock encrusting should follow cavities; spur turf reads as felt; coral tips need scattering.
5. Distant sand keeps ripple contrast past 25 m; seed 1 lacks depth darkening.
6. Grass aliasing against the bright surface; camera clips a jellyfish; shaft tops ending mid-water.
7. Slope caustics still a white crack web; overhead ridge caustics tile.

What works: seed 3/4 reef frames (closest to HFW), seed 3 grade fix, surface sunbursts, backlit kelp colour,
schools over the reef, reduced overhead haze, stability. Variety now passes.

## Review 7 — commit (post 6-fixes) — FAIL (avg 6.2)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 7 |
| 3 | Caustics | 6 |
| 4 | Materials | 5 |
| 5 | Geometry & silhouettes | 6 |
| 6 | Life & animation | 6 |
| 7 | Composition, grade & mood | 6 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 6 |

Biggest gaps (ranked):
1. Kelp close-ups read as bamboo/palm: fewer, wider, ruffled, round-tipped blades; absorb canopy colour; no blue rim on stipes; kelp camera needs a stipe silhouette and open water.
2. Pixel dither speckle on rock/turf (seed2-reef, seed4-reef).
3. No vertical reef; antler-coral monotony; bommies as stacked pancakes.
4. Fish read as leaves/specks; schools small spheres; fade fish near camera.
5. Caustic hot spots near camera; giraffe-cell sand pattern (seed1-overhead).
6. Seed 4 shaft curtain and milky haze.
7. Surface camera has no subject.

What works: seed2-reef frame, mid-distance kelp forests, ripple distance fade, palettes, temporal stability, surface sunburst.

## Review 8 — FAIL (avg 6.1)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 7 |
| 3 | Caustics | 5 |
| 4 | Materials | 5 |
| 5 | Geometry & silhouettes | 6 |
| 6 | Life & animation | 6 |
| 7 | Composition, grade & mood | 6 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 6 |

Biggest gaps (ranked):
1. Materials: plastic table plates (need rim thickness, dark AO underside), clay rocks with black decal pits, DOF smearing near terrain into colour.
2. Kelp close-ups like lettuce: blades along the whole stipe, faceted edges, weak sway.
3. Caustics over-softened: bring back a sharp animated network on sand, rock tops and coral.
4. Hero fish still toys; mid-distance fish blurred.
5. Framing: reef/wide near-duplicates; bare blurred mound foregrounds; overhead lacks a focal point.
6. Bommies read as snowman stacks.
7. Far ridges silhouette hard; seed 2 lacks vertical gradient; bright cyan background mound.
8. Evenly spaced parallel shafts.

What works: seed2/seed4 surface shots near key-art quality; ribbon school over pillar in seed4-wide; seed3 grade; speckle and cell artifacts fixed; richer coral mix.

## Review 9 — FAIL (avg 6.2)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 7 |
| 3 | Caustics | 6 |
| 4 | Materials | 5 |
| 5 | Geometry & silhouettes | 6 |
| 6 | Life & animation | 6 |
| 7 | Composition, grade & mood | 6 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 6 |

Biggest gaps (ranked):
1. Materials: uniform mossy clay rocks (need hue/roughness variation, wet top specular, crevice AO); plastic table corals; kelp needs backlit glow on every seed.
2. Close-up kelp faceted, background slivers between blades.
3. DOF smear streaks on near terrain, dither checker on seed4 rock; seed1 reef/wide duplicate framing.
4. Fish don't read as animals up close.
5. Caustics weak on rock/coral tops.
6. Reds don't fade with distance.
7. Lone hard shaft in seed2; milky near shaft in seed4-reef.

What works: shaft bundles (seed3/4 wide), seed2 palette, seed3-reef kelp framing, far terrain dissolve, Snell's window, overhead coral density, seed3-kelp dappling.

## Review 10 — FAIL (avg 6.3)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 7 |
| 3 | Caustics | 6 |
| 4 | Materials | 6 |
| 5 | Geometry & silhouettes | 6 |
| 6 | Life & animation | 6 |
| 7 | Composition, grade & mood | 6 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 6 |

Biggest gaps (ranked):
1. Fish still toys: need view-dependent sheen, see-through fins, dark backs and silver bellies so schools read as fish.
2. Rocks with repeated pocket stamp; plastic table corals.
3. Caustics don't reach rocks and coral.
4. Weak foregrounds (seed1/seed4 reef).
5. Seed 4 kelp muddy; starfield-like particles in dark water.
6. Overheads flat cyan.
7. Lone hard shaft (seed2-wide).

What works: kelp translucency near reference, surface views, shaft fans, seed2-reef, temporal stability, distinct moods.

## Review 11 — FAIL (avg 6.6)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 7 |
| 3 | Caustics | 7 |
| 4 | Materials | 6 |
| 5 | Geometry & silhouettes | 6 |
| 6 | Life & animation | 6 |
| 7 | Composition, grade & mood | 6 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 7 |

Biggest gaps (ranked):
1. Fish: readable heads and eyes, thicker bodies that don't collapse edge-on; a mid-size school in reef shots.
2. Plastic corals: table tops, candy tube gradients with white tips, sawtooth barrel sponge rims.
3. Bare mound foregrounds (seed1/seed3 reef).
4. Seed 4 kelp muddy olive with no blue gaps.
5. Flat overheads with no focal point.
6. Caustics on vertical rock faces and coral branches.

What works: surface cameras near AAA, seed4-reef layered foreground, kelp forests seeds 1-3, sand caustics, palettes, particles.

## Review 12 — FAIL (avg 6.7)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 7 |
| 3 | Caustics | 7 |
| 4 | Materials | 6 |
| 5 | Geometry & silhouettes | 6 |
| 6 | Life & animation | 7 |
| 7 | Composition, grade & mood | 6 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 7 |

Biggest gaps (ranked):
1. Plastic coral/plant materials: flat single colours, neon wire strands (sea whips), no base AO.
2. Kelp reads as a curtain: regular ladder stems, specular slivers, no floor/focal point in kelp shots.
3. Seed4-wide washed out by shaft veil; mostly empty frame.
4. Low-detail close foregrounds; stacked pancake table corals.
5. School fish grey/see-through with glowing snouts; uniform size/spacing.

What works: seed4-reef best frame, seed2 deep-blue, surface shots, seed4 kelp backlight, 3/4 overhead, temporal stability.

## Review 13 — FAIL (avg 6.8)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 7 |
| 3 | Caustics | 7 |
| 4 | Materials | 6 |
| 5 | Geometry & silhouettes | 6 |
| 6 | Life & animation | 7 |
| 7 | Composition, grade & mood | 7 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 7 |

Biggest gaps (ranked):
1. Branching coral pale smooth tubes with rim glow; table corals need thick lips and shaded undersides.
2. Kelp still a regimented wall in some seeds; faceted blade tips; no light-through.
3. School fish ghosted near camera (DOF); need crisp silver flashes and size variety.
4. Blobby rock pillars and dotted brain coral.
5. Empty surface frames and subjectless wide shot (seed4).

What works: seed4-wide veil fixed, muted sea whips, no glowing snouts, seed2 deep-blue grade, seed4-reef warm shafts, caustics, stability.

## Review 14 — FAIL (avg 6.8)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 7 |
| 3 | Caustics | 7 |
| 4 | Materials | 6 |
| 5 | Geometry & silhouettes | 6 |
| 6 | Life & animation | 7 |
| 7 | Composition, grade & mood | 7 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 7 |

Biggest gaps (ranked):
1. Pillars read as stacked pancakes (regular ledges).
2. Brain coral veins are colour not relief; table corals flat discs.
3. Edge-on tables and base-less whip fragments at the surface lens.
4. Kelp uniform hedge; far LOD reads as streak cards.
5. Same rock palette in every seed.
6. Weak focal hierarchy in reef/wide shots.
7. Curious fish soft/ghosted near lens.

What works: surface cameras near reference mood, kelp backlighting, school volumes, sand caustics, no floating coral, distance fog.

## Review 15 — FAIL (avg 6.7)

Scores: lighting 7, water 7, caustics 7, materials 6, geometry 6, life 7, composition 7, variety 7, artifacts 6.
Gaps: coral heads without relief; stacked table corals with ring moiré; ghosted coral from the lens dissolve; barcode whip in seed1-reef; kelp walls; blanket mounds; flat close fish; empty seed4-wide.

## Review 16 — FAIL (avg 6.7)

| # | Category | Score |
|---|----------|-------|
| 1 | Lighting & light shafts | 7 |
| 2 | Water medium | 7 |
| 3 | Caustics | 7 |
| 4 | Materials | 6 |
| 5 | Geometry & silhouettes | 6 |
| 6 | Life & animation | 7 |
| 7 | Composition, grade & mood | 7 |
| 8 | Variety across seeds | 7 |
| 9 | Technical artifacts | 6 |

Biggest gaps (ranked):
1. Coral reads as clay: needs polyp/pit micro-normals, cavity AO, wet sheen, fine mottling not camouflage blotches.
2. Coral silhouettes: lily-pad tables with polygon rims, prism finger coral, blob sponges.
3. Blanket foreground mounds; ripple seam in seed4-reef.
4. Few fish around the reef cameras' focal coral.
5. Kelp walls; far kelp LOD turns to hair.
6. Seed 2 monotone blue.

What works: surface views, sand caustics, depth layering, seed3-reef composition, all review-15 fixes landed, temporal stability, inhabited scenes.

## Review 17 — FAIL (avg 6.7)

Scores: lighting 7, water 7, caustics 7, materials 6, geometry 6, life 7, composition 7, variety 7, artifacts 6.
Gaps: brain coral zebra stripes at mid distance; blanket terrain mounds; lily-pad tables on open sand; kelp walls and hairy far kelp; sparse fish at focal points; seed 2 monotone; foreground texture smear, sand stain, kelp cutouts.
Works: shafts and sun disc, sand caustics, near brain coral relief, rounded branch coral, distance absorption, stability, bait ball and ray.

## Review 18 — FAIL (avg 6.7)

Scores: lighting 7, water 7, caustics 7, materials 6, geometry 6, life 7, composition 7, variety 7, artifacts 6.
Gaps: brain coral zebra colour and stair-stepped mesh relief; lily-pad plate corals (need tilt, stalk, dark underside); kelp camera walls; sea-whip tips still crossing the lens; empty focal points; paper-cup barrel sponges and blanket mounds; seed 2 violet-on-blue.
Works: surface shots, backlit kelp canopy, sand caustics with rubble, bait balls and jellies, deep-blue identity, temporal stability.

## Mobile tier review (mobile18) — FAIL (avg 6.2; bar: all ≥6)

Scores: lighting 7, water 7, caustics 5, materials 6, geometry 6, life 6, composition 7, variety 6, artifacts 6.
Gaps: caustics nearly invisible (smaller caustics texture blurred by the shared mip bias — fixed with a per-size bias); smeared foreground terrain; blobby low-res mounds; sticker-like coral heads; seeds 1/3 similar; few close fish.
Works: kelp forests top-tier for mobile, surface views, shafts and fog survive the mobile cuts.

## Mobile tier review 19 — PASS (avg 6.4; bar: all ≥6)

Scores: lighting 7, water 7, caustics 6, materials 6, geometry 6, life 6, composition 7, variety 7, artifacts 6.
Remaining gaps: terrain slope too close in seed1-surface; milky caustic contrast; blobby mounds; flat coral blobs; a large near bubble sprite; square kelp tips.
Works: surface views, sunlit kelp forests, seed2 deep-blue mood, sand ripples and rock at the higher render scale.
