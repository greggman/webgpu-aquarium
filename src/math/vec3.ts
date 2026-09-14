// Small vec3 helpers. Vec3 is a plain tuple so it is cheap to create and easy to
// read; functions take an optional `out` to avoid allocation in hot paths.

export type Vec3 = [number, number, number];

export const create = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const clone = (a: Readonly<Vec3>): Vec3 => [a[0], a[1], a[2]];

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function copy(out: Vec3, a: Readonly<Vec3>): Vec3 {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function add(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function sub(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function scale(
  a: Readonly<Vec3>,
  s: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

/** out = a + b * s */
export function addScaled(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  s: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function lerp(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  t: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function cross(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export const length = (a: Readonly<Vec3>) => Math.hypot(a[0], a[1], a[2]);

export const distance = (a: Readonly<Vec3>, b: Readonly<Vec3>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function normalize(a: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  const s = l > 1e-12 ? 1 / l : 0;
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}
