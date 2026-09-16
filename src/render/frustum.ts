// Frustum culling against a view-projection matrix.
//
// The obvious test — compare clip x/y against w with a padding in world units
// — is wrong: clip space is scaled by the projection, so the same padding
// means different things on each axis and at every aspect ratio. In a tall,
// narrow window the horizontal scale is an order of magnitude larger than the
// vertical one, the padding shrinks to nothing, and anything whose centre
// falls just outside an edge pops out while still half on screen.
//
// Extracting the planes and normalizing them puts the test back in world
// units, so one radius means the same thing on every side, at any shape of
// window, for perspective and orthographic alike.

/** Left, right, bottom and top planes as (nx, ny, nz, d), 16 floats. */
export function sidePlanes(
  m: Float32Array,
  out = new Float32Array(16),
): Float32Array {
  // Column-major: clip.x is row 0 of the matrix (m0, m4, m8, m12), and so on.
  for (let i = 0; i < 4; i++) {
    // Planes come in pairs: w + axis (left/bottom), then w - axis.
    const axis = i >> 1;
    const s = i & 1 ? -1 : 1;
    let nx = m[3] + s * m[axis];
    let ny = m[7] + s * m[axis + 4];
    let nz = m[11] + s * m[axis + 8];
    let d = m[15] + s * m[axis + 12];
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    d /= len;
    out.set([nx, ny, nz, d], i * 4);
  }
  return out;
}

/**
 * True when an axis-aligned box lies entirely outside at least one plane.
 *
 * Testing a box by its corners in clip space instead looks reasonable and is
 * wrong: a corner behind the camera has a negative w, which flips every
 * comparison against it, so a box the camera sits inside can be judged to be
 * entirely off one side and vanish. In world space, against normalized planes,
 * there is no such trap.
 */
export function boxOutside(
  planes: Float32Array,
  min: readonly number[],
  max: readonly number[],
): boolean {
  for (let i = 0; i < planes.length; i += 4) {
    const nx = planes[i];
    const ny = planes[i + 1];
    const nz = planes[i + 2];
    // The corner furthest along the plane's normal: if even that one is behind
    // the plane, all eight are.
    const px = nx >= 0 ? max[0] : min[0];
    const py = ny >= 0 ? max[1] : min[1];
    const pz = nz >= 0 ? max[2] : min[2];
    if (nx * px + ny * py + nz * pz + planes[i + 3] < 0) {
      return true;
    }
  }
  return false;
}

/** True when a sphere is at least partly inside all four side planes. */
export function sphereInside(
  planes: Float32Array,
  x: number,
  y: number,
  z: number,
  radius: number,
): boolean {
  for (let i = 0; i < 16; i += 4) {
    if (
      planes[i] * x + planes[i + 1] * y + planes[i + 2] * z + planes[i + 3] <
      -radius
    ) {
      return false;
    }
  }
  return true;
}
