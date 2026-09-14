import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NavVolume} from '../../src/player/navvolume.ts';
import type {Vec3} from '../../src/math/vec3.ts';

const flat = (y: number) => () => y;

function volume(
  extra: Partial<ConstructorParameters<typeof NavVolume>[0]> = {},
) {
  return new NavVolume({
    heightAt: flat(-20),
    center: [0, 0],
    radiusAt: () => 30,
    surfaceY: 0,
    ceilingGap: 3,
    floorClearance: 1.5,
    softZone: 10,
    ...extra,
  });
}

test('camera never goes below the floor clearance for long', () => {
  const nav = volume();
  const pos: Vec3 = [0, -25, 0];
  const vel: Vec3 = [0, -5, 0];
  for (let i = 0; i < 120; i++) {
    nav.constrain(pos, vel, 1 / 60);
  }
  assert.ok(pos[1] > -18.6, `y=${pos[1]}`);
  assert.ok(vel[1] >= 0);
});

test('camera is held below the ceiling', () => {
  const nav = volume();
  const pos: Vec3 = [0, -1, 0];
  const vel: Vec3 = [0, 3, 0];
  nav.constrain(pos, vel, 1 / 60);
  assert.equal(pos[1], -3);
  assert.equal(vel[1], 0);
});

test('horizontal boundary is soft then hard', () => {
  const nav = volume();
  // Inside the comfortable area nothing happens.
  const inside: Vec3 = [5, -10, 0];
  const v1: Vec3 = [1, 0, 0];
  nav.constrain(inside, v1, 1 / 60);
  assert.deepEqual(v1, [1, 0, 0]);
  // In the soft zone, outward velocity is reduced by the push-back current.
  const soft: Vec3 = [27, -10, 0];
  const v2: Vec3 = [2, 0, 0];
  nav.constrain(soft, v2, 1 / 60);
  assert.ok(v2[0] < 2);
  // Past the hard edge the position is clamped.
  const out: Vec3 = [40, -10, 0];
  const v3: Vec3 = [2, 0, 0];
  nav.constrain(out, v3, 1 / 60);
  assert.ok(Math.hypot(out[0], out[2]) <= 30 + 1e-6);
  assert.ok(v3[0] <= 0);
});

test('obstacles push the camera out', () => {
  const nav = volume({obstacles: [{center: [0, -10, 0], radius: 2}]});
  const pos: Vec3 = [0.5, -10, 0];
  const vel: Vec3 = [-1, 0, 0];
  nav.constrain(pos, vel, 1 / 60);
  assert.ok(Math.hypot(pos[0], pos[1] + 10, pos[2]) >= 2.6 - 1e-6);
  assert.ok(!nav.contains([0, -10, 0]));
  assert.ok(nav.contains([10, -10, 10]));
});
