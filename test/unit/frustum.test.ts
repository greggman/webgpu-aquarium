import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as mat4 from '../../src/math/mat4.ts';
import {sidePlanes, sphereInside} from '../../src/render/frustum.ts';

/** Camera at the origin looking down -z, with the given window shape. */
function view(width: number, height: number) {
  const proj = mat4.perspectiveReversedZ(
    (68 * Math.PI) / 180,
    width / height,
    0.05,
  );
  const v = mat4.lookAt([0, 0, 0], [0, 0, -1], [0, 1, 0]);
  return sidePlanes(mat4.multiply(proj, v));
}

test('frustum planes are in world units whatever the aspect', () => {
  for (const [w, h] of [
    [1920, 1080],
    [150, 1300],
    [1300, 150],
  ] as const) {
    const planes = view(w, h);
    // Straight ahead is always inside; straight behind never leaves the side
    // planes (that is what the separate w test is for).
    assert.ok(sphereInside(planes, 0, 0, -10, 0.1), `${w}x${h} centre`);

    // Walk out to the side until the centre leaves the frustum, then check
    // that a sphere reaching back in is still kept.
    const edge = (axis: 0 | 1) => {
      const p: [number, number, number] = [0, 0, -10];
      let d = 0;
      while (d < 100) {
        p[axis] = d;
        if (!sphereInside(planes, p[0], p[1], p[2], 0)) {
          return d;
        }
        d += 0.01;
      }
      throw new Error('never left the frustum');
    };
    for (const axis of [0, 1] as const) {
      const d = edge(axis);
      const p: [number, number, number] = [0, 0, -10];
      // Just outside by a tenth of a metre: a sphere of half a metre still
      // overlaps the frustum and must be kept, on either axis.
      p[axis] = d + 0.1;
      assert.ok(
        sphereInside(planes, p[0], p[1], p[2], 0.5),
        `${w}x${h} axis ${axis}: sphere overlapping the edge was culled`,
      );
      // A metre outside with no radius is gone.
      p[axis] = d + 1;
      assert.ok(
        !sphereInside(planes, p[0], p[1], p[2], 0),
        `${w}x${h} axis ${axis}: point outside was kept`,
      );
    }
  }
});

test('orthographic (shadow) matrices give world-unit planes too', () => {
  const proj = mat4.orthoReversedZ(-20, 20, -10, 10, 0.1, 100);
  const v = mat4.lookAt([0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const planes = sidePlanes(mat4.multiply(proj, v));
  assert.ok(sphereInside(planes, 19, 9, -10, 0.1));
  assert.ok(sphereInside(planes, 20.4, 0, -10, 0.5), 'overlapping edge kept');
  assert.ok(!sphereInside(planes, 21, 0, -10, 0.5), 'clear of the edge culled');
});
