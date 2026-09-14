// Auto-focus for depth of field: what is the camera looking at?

import type {GenContext} from '../world/layout.ts';

/** Distance along the view ray to the first terrain, rock or reef hit. */
export function focusDistance(
  pos: readonly number[],
  dir: readonly number[],
  gen: GenContext,
): number {
  let best = 30;
  for (let t = 0.5; t < 30; t += 0.25) {
    const x = pos[0] + dir[0] * t;
    const y = pos[1] + dir[1] * t;
    const z = pos[2] + dir[2] * t;
    if (y < gen.terrain.heightAt(x, z) + 0.3) {
      best = t;
      break;
    }
  }
  const hits = [
    ...gen.obstacles.map(o => ({c: o.center, r: o.radius})),
    ...gen.clusters.map(c => ({c: [c.x, c.y + 0.8, c.z], r: c.radius * 0.6})),
  ];
  for (const h of hits) {
    const ox = h.c[0] - pos[0];
    const oy = h.c[1] - pos[1];
    const oz = h.c[2] - pos[2];
    const along = ox * dir[0] + oy * dir[1] + oz * dir[2];
    if (along <= 0) {
      continue;
    }
    const d2 = ox * ox + oy * oy + oz * oz - along * along;
    if (d2 < h.r * h.r) {
      best = Math.min(best, Math.max(0.5, along - Math.sqrt(h.r * h.r - d2)));
    }
  }
  return best;
}
