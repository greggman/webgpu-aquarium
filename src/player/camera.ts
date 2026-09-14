// Swim camera: a first-person diver/drone with inertia, banking and a gentle
// bob, constrained to the play area.

import * as vec3 from '../math/vec3.ts';
import * as mat4 from '../math/mat4.ts';
import type {Vec3} from '../math/vec3.ts';
import type {InputState} from './input.ts';
import type {NavVolume} from './navvolume.ts';

export interface CameraPose {
  pos: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
}

export function forwardFromAngles(
  yaw: number,
  pitch: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  const cp = Math.cos(pitch);
  return vec3.set(
    out,
    -Math.sin(yaw) * cp,
    Math.sin(pitch),
    -Math.cos(yaw) * cp,
  );
}

export function anglesFromDirection(dir: Readonly<Vec3>): {
  yaw: number;
  pitch: number;
} {
  const d = vec3.normalize(dir);
  return {
    yaw: Math.atan2(-d[0], -d[2]),
    pitch: Math.asin(Math.max(-1, Math.min(1, d[1]))),
  };
}

export function viewMatrix(
  pose: CameraPose,
  out: mat4.Mat4 = new Float32Array(16),
) {
  const f = forwardFromAngles(pose.yaw, pose.pitch);
  const right = vec3.normalize(vec3.cross(f, [0, 1, 0]));
  const up = vec3.cross(right, f);
  const c = Math.cos(pose.roll);
  const s = Math.sin(pose.roll);
  const rolledUp: Vec3 = [
    up[0] * c + right[0] * s,
    up[1] * c + right[1] * s,
    up[2] * c + right[2] * s,
  ];
  return mat4.lookAt(pose.pos, vec3.add(pose.pos, f), rolledUp, out);
}

const MAX_PITCH = 1.35;

export class SwimCamera {
  pose: CameraPose = {pos: [0, -10, 0], yaw: 0, pitch: 0, roll: 0};
  vel: Vec3 = [0, 0, 0];
  private yawRate = 0;
  private bobPhase = 0;
  private lookVel: [number, number] = [0, 0];

  setPose(pos: Readonly<Vec3>, target: Readonly<Vec3>) {
    const {yaw, pitch} = anglesFromDirection(vec3.sub(target, pos));
    this.pose = {pos: vec3.clone(pos), yaw, pitch, roll: 0};
    this.vel = [0, 0, 0];
    this.lookVel = [0, 0];
  }

  update(input: InputState, dt: number, nav: NavVolume | null) {
    if (dt <= 0) {
      return;
    }
    const p = this.pose;

    // Look: lightly smoothed so mouse and touch feel fluid, not twitchy.
    const smooth = 1 - Math.exp(-dt * 30);
    this.lookVel[0] += (input.look[0] / dt - this.lookVel[0]) * smooth;
    this.lookVel[1] += (input.look[1] / dt - this.lookVel[1]) * smooth;
    p.yaw += this.lookVel[0] * dt;
    p.pitch = Math.max(
      -MAX_PITCH,
      Math.min(MAX_PITCH, p.pitch + this.lookVel[1] * dt),
    );

    // Swim: accelerate along view direction; vertical input is world-up.
    const f = forwardFromAngles(p.yaw, p.pitch);
    const right = vec3.normalize(vec3.cross(f, [0, 1, 0]));
    const maxSpeed = input.sprint ? 9 : 3.6;
    const accel = input.sprint ? 14 : 8;
    const wish: Vec3 = [0, 0, 0];
    vec3.addScaled(wish, f, input.move[2], wish);
    vec3.addScaled(wish, right, input.move[0], wish);
    wish[1] += input.move[1];
    const wl = vec3.length(wish);
    if (wl > 1) {
      vec3.scale(wish, 1 / wl, wish);
    }
    vec3.addScaled(this.vel, wish, accel * dt, this.vel);

    // Water drag: stronger when not swimming so you glide to a stop.
    const drag = wl > 0.01 ? 1.2 : 1.8;
    vec3.scale(this.vel, Math.exp(-drag * dt), this.vel);
    const speed = vec3.length(this.vel);
    if (speed > maxSpeed) {
      vec3.scale(this.vel, maxSpeed / speed, this.vel);
    }

    vec3.addScaled(p.pos, this.vel, dt, p.pos);
    nav?.constrain(p.pos, this.vel, dt);

    // Bank into turns, and bob gently with swimming.
    this.yawRate += (this.lookVel[0] - this.yawRate) * (1 - Math.exp(-dt * 4));
    const lateral = vec3.dot(this.vel, right);
    const targetRoll = Math.max(
      -0.2,
      Math.min(0.2, -this.yawRate * 0.06 - lateral * 0.02),
    );
    p.roll += (targetRoll - p.roll) * (1 - Math.exp(-dt * 3));
    this.bobPhase += dt * (0.6 + speed * 0.5);
  }

  /** Pose with idle bob applied, for rendering. */
  renderPose(): CameraPose {
    const p = this.pose;
    const bob = Math.sin(this.bobPhase * 1.3) * 0.04;
    return {
      pos: [p.pos[0], p.pos[1] + bob, p.pos[2]],
      yaw: p.yaw + Math.sin(this.bobPhase * 0.7) * 0.004,
      pitch: p.pitch + Math.sin(this.bobPhase * 0.9) * 0.004,
      roll: p.roll,
    };
  }
}
