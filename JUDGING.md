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
