// The region the camera may swim in. Built per seed from the generated world so
// the camera stays where the scene was designed to look good.

import type {Vec3} from '../math/vec3.ts';

export interface NavSphere {
  center: Vec3;
  radius: number;
}

export interface NavVolumeOptions {
  /** Terrain height at (x, z). */
  heightAt: (x: number, z: number) => number;
  center: [number, number];
  /** Allowed horizontal radius as a function of angle (radians). */
  radiusAt: (angle: number) => number;
  surfaceY: number;
  /** Keep this far below the surface. */
  ceilingGap: number;
  /** Keep this far above the ground. */
  floorClearance: number;
  /** Width of the soft boundary zone where the current pushes back. */
  softZone: number;
  obstacles?: NavSphere[];
}

export class NavVolume {
  readonly o: NavVolumeOptions;

  constructor(o: NavVolumeOptions) {
    this.o = o;
  }

  /** Lowest allowed camera height at (x, z), considering nearby ground. */
  floorAt(x: number, z: number): number {
    const h = this.o.heightAt;
    const r = 0.8;
    const ground = Math.max(
      h(x, z),
      h(x + r, z),
      h(x - r, z),
      h(x, z + r),
      h(x, z - r),
    );
    return ground + this.o.floorClearance;
  }

  ceiling(): number {
    return this.o.surfaceY - this.o.ceilingGap;
  }

  /**
   * How far past the soft boundary a point is horizontally: 0 inside the
   * comfortable area, rising to 1 at the hard edge.
   */
  edgeFactor(x: number, z: number): number {
    const dx = x - this.o.center[0];
    const dz = z - this.o.center[1];
    const r = Math.hypot(dx, dz);
    const R = this.o.radiusAt(Math.atan2(dz, dx));
    return Math.min(
      1,
      Math.max(0, (r - (R - this.o.softZone)) / this.o.softZone),
    );
  }

  /**
   * Keeps `pos` inside the volume, bleeding off velocity that points out of it.
   * Edges are soft: a push-back acceleration grows through the soft zone and
   * the hard limit is only reached if the player insists.
   */
  constrain(pos: Vec3, vel: Vec3, dt: number) {
    const {center, radiusAt} = this.o;

    // Horizontal boundary.
    const dx = pos[0] - center[0];
    const dz = pos[2] - center[1];
    const r = Math.hypot(dx, dz);
    if (r > 1e-6) {
      const nx = dx / r;
      const nz = dz / r;
      const R = radiusAt(Math.atan2(dz, dx));
      const edge = this.edgeFactor(pos[0], pos[2]);
      if (edge > 0) {
        const outward = vel[0] * nx + vel[2] * nz;
        // Current pushing back toward the middle, stronger near the edge.
        const push = edge * edge * 14;
        vel[0] -= nx * push * dt;
        vel[2] -= nz * push * dt;
        if (outward > 0) {
          const damp = Math.min(1, edge * edge * 6 * dt);
          vel[0] -= nx * outward * damp;
          vel[2] -= nz * outward * damp;
        }
      }
      if (r > R) {
        pos[0] = center[0] + nx * R;
        pos[2] = center[1] + nz * R;
        const outward = vel[0] * nx + vel[2] * nz;
        if (outward > 0) {
          vel[0] -= nx * outward;
          vel[2] -= nz * outward;
        }
      }
    }

    // Floor and ceiling.
    const floor = this.floorAt(pos[0], pos[2]);
    const ceil = this.ceiling();
    const minY = Math.min(floor, ceil - 0.5);
    if (pos[1] < minY) {
      // Glide up over the ground rather than snapping.
      const k = Math.min(1, dt * 10);
      pos[1] += (minY - pos[1]) * k;
      if (pos[1] < minY - 0.6) {
        pos[1] = minY - 0.6;
      }
      if (vel[1] < 0) {
        vel[1] = 0;
      }
    }
    if (pos[1] > ceil) {
      pos[1] = ceil;
      if (vel[1] > 0) {
        vel[1] = 0;
      }
    }

    // Large obstacles (rocks, coral heads).
    for (const s of this.o.obstacles ?? []) {
      const ox = pos[0] - s.center[0];
      const oy = pos[1] - s.center[1];
      const oz = pos[2] - s.center[2];
      const d = Math.hypot(ox, oy, oz);
      const minD = s.radius + 0.6;
      if (d < minD && d > 1e-6) {
        const k = (minD - d) / d;
        pos[0] += ox * k;
        pos[1] += oy * k;
        pos[2] += oz * k;
        const into = (vel[0] * ox + vel[1] * oy + vel[2] * oz) / d;
        if (into < 0) {
          vel[0] -= (ox / d) * into;
          vel[1] -= (oy / d) * into;
          vel[2] -= (oz / d) * into;
        }
      }
    }
  }

  /** True when the point is a valid camera position. */
  contains(p: Readonly<Vec3>): boolean {
    const dx = p[0] - this.o.center[0];
    const dz = p[2] - this.o.center[1];
    const R = this.o.radiusAt(Math.atan2(dz, dx));
    return (
      Math.hypot(dx, dz) <= R &&
      p[1] >= this.floorAt(p[0], p[2]) - 1e-3 &&
      p[1] <= this.ceiling() + 1e-3
    );
  }
}
