// Attract mode: when nobody is at the controls, glide through the world's
// hero spots along a smooth spline. Any input hands control back.

import * as vec3 from '../math/vec3.ts';
import type {Vec3} from '../math/vec3.ts';
import {anglesFromDirection, type CameraPose} from './camera.ts';

export interface TourStop {
  pos: Vec3;
  target: Vec3;
}

function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] =
      0.5 *
      (2 * p1[i] +
        (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  }
  return out;
}

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class AttractTour {
  private stops: TourStop[];
  private u = 0;
  private blend = 0;
  private from: CameraPose | null = null;
  /** Travel speed along the path, metres per second (a slow, drifting glide). */
  speed: number;
  /** Minimum seconds per segment, so short hops don't whip the view around. */
  minSegmentTime: number;
  private segmentLength: number[] = [];

  constructor(stops: TourStop[], speed = 0.7, minSegmentTime = 14) {
    this.stops = stops;
    this.speed = speed;
    this.minSegmentTime = minSegmentTime;
    // Arc length of each spline segment, measured by sampling.
    for (let i = 0; i < stops.length; i++) {
      let len = 0;
      let prev = this.sample(i).pos;
      for (let k = 1; k <= 16; k++) {
        const p = this.sample(i + k / 16).pos;
        len += vec3.distance(prev, p);
        prev = p;
      }
      this.segmentLength.push(len);
    }
  }

  /** Starts (or restarts) the tour from the nearest stop, blending from `current`. */
  begin(current: CameraPose) {
    let best = 0;
    let bestD = Infinity;
    this.stops.forEach((s, i) => {
      const d = vec3.distance(s.pos, current.pos);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    this.u = best;
    this.blend = 0;
    this.from = {...current, pos: vec3.clone(current.pos)};
  }

  private sample(u: number): CameraPose {
    const n = this.stops.length;
    const i = Math.floor(u);
    const t = u - i;
    const at = (k: number) => this.stops[((k % n) + n) % n];
    const pos = catmullRom(
      at(i - 1).pos,
      at(i).pos,
      at(i + 1).pos,
      at(i + 2).pos,
      t,
    );
    const target = catmullRom(
      at(i - 1).target,
      at(i).target,
      at(i + 1).target,
      at(i + 2).target,
      t,
    );
    const {yaw, pitch} = anglesFromDirection(vec3.sub(target, pos));
    return {pos, yaw, pitch, roll: 0};
  }

  update(dt: number): CameraPose {
    const ease = (x: number) => x * x * (3 - 2 * x);
    const seg = Math.floor(this.u) % this.stops.length;
    const segTime = Math.max(
      this.minSegmentTime,
      (this.segmentLength[seg] ?? 0) / this.speed,
    );
    this.u = (this.u + dt / segTime) % this.stops.length;
    const p = this.sample(this.u);
    // Bank slightly along the path's curvature.
    const ahead = this.sample((this.u + 0.05) % this.stops.length);
    let dyaw = ahead.yaw - p.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    p.roll = Math.max(-0.12, Math.min(0.12, -dyaw * 0.8));
    if (this.from && this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 5);
      const t = ease(this.blend);
      return {
        pos: vec3.lerp(this.from.pos, p.pos, t),
        yaw: lerpAngle(this.from.yaw, p.yaw, t),
        pitch: this.from.pitch + (p.pitch - this.from.pitch) * t,
        roll: this.from.roll + (p.roll - this.from.roll) * t,
      };
    }
    return p;
  }
}
