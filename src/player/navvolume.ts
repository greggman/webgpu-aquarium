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

  /** Ground slope (dh/dx, dh/dz) at (x, z), in metres per metre. */
  slopeAt(x: number, z: number): [number, number] {
    const h = this.o.heightAt;
    const e = 0.7;
    return [
      (h(x + e, z) - h(x - e, z)) / (2 * e),
      (h(x, z + e) - h(x, z - e)) / (2 * e),
    ];
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

    // Floor, walls and ceiling. Gentle ground is climbed, as before; steep
    // ground (the side of a canyon or gully) pushes back horizontally and is
    // slid along, so the camera goes round a wall instead of riding up it.
    const ceil = this.ceiling();
    for (let iter = 0; iter < 2; iter++) {
      const floor = this.floorAt(pos[0], pos[2]);
      const minY = Math.min(floor, ceil - 0.5);
      const deep = minY - pos[1];
      if (deep <= 0) {
        break;
      }
      const [gx, gz] = this.slopeAt(pos[0], pos[2]);
      const slope = Math.hypot(gx, gz);
      const wall = wallness(slope);
      if (wall > 0 && slope > 1e-3) {
        // Out of the slope, downhill, keeping whatever motion runs along it.
        const nx = -gx / slope;
        const nz = -gz / slope;
        const push = Math.min(deep, 1.5) * wall * Math.min(1, dt * 12);
        pos[0] += nx * push;
        pos[2] += nz * push;
        const into = -(vel[0] * nx + vel[2] * nz);
        if (into > 0) {
          vel[0] += nx * into;
          vel[2] += nz * into;
        }
      }
      pos[1] += deep * (1 - wall) * Math.min(1, dt * 10);
      const allowed = minY - 0.6 - wall * 2.5;
      if (pos[1] < allowed) {
        pos[1] = allowed;
      }
      if (vel[1] < 0 && wall < 0.5) {
        vel[1] = 0;
      }
      if (wall <= 0) {
        break;
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
    const clearOfObstacles = (this.o.obstacles ?? []).every(
      s =>
        Math.hypot(p[0] - s.center[0], p[1] - s.center[1], p[2] - s.center[2]) >
        s.radius + 0.6,
    );
    return (
      clearOfObstacles &&
      Math.hypot(dx, dz) <= R &&
      p[1] >= this.floorAt(p[0], p[2]) - 1e-3 &&
      p[1] <= this.ceiling() + 1e-3
    );
  }
}

/** 0 on ground gentle enough to swim over, 1 on a wall. */
function wallness(slope: number): number {
  const t = Math.max(0, Math.min(1, (slope - 0.75) / 0.95));
  return t * t * (3 - 2 * t);
}
