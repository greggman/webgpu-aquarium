import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defineStruct, StructBuffer, typeInfo} from '../../src/gpu/structs.ts';
import {Rng} from '../../src/core/rng.ts';
import * as mat4 from '../../src/math/mat4.ts';

test('WGSL type sizes and alignment', () => {
  assert.deepEqual(typeInfo('f32'), {align: 4, size: 4});
  assert.deepEqual(typeInfo('vec3f'), {align: 16, size: 12});
  assert.deepEqual(typeInfo('mat4x4f'), {align: 16, size: 64});
  assert.deepEqual(typeInfo('mat3x3f'), {align: 16, size: 48});
  assert.deepEqual(typeInfo('array<vec3f, 4>'), {align: 16, size: 64});
  assert.deepEqual(typeInfo('array<f32, 3>'), {align: 4, size: 12});
});

test('struct layout follows WGSL rules', () => {
  const s = defineStruct('S', {
    a: 'f32',
    b: 'vec3f',
    c: 'f32',
    d: 'mat4x4f',
    e: 'vec2f',
  });
  // a@0, b aligns to 16, c packs after b at 28, d aligns to 32, e at 96
  assert.deepEqual(s.offsets, {a: 0, b: 16, c: 28, d: 32, e: 96});
  assert.equal(s.size, 112); // 104 rounded up to align 16
  assert.match(s.wgsl, /struct S \{\n {2}a: f32,/);

  const v = defineStruct('V', {p: 'vec3f', w: 'f32'});
  assert.equal(v.offsets.w, 12);
  assert.equal(v.size, 16);
});

test('StructBuffer writes fields at the right offsets', () => {
  const s = defineStruct('T', {x: 'f32', n: 'u32', v: 'vec3f', m: 'mat3x3f'});
  const buf = new StructBuffer(s, 2);
  buf.set('x', 1.5, 1);
  buf.set('n', 7, 1);
  buf.set('v', [1, 2, 3], 1);
  buf.set('m', [1, 2, 3, 4, 5, 6, 7, 8, 9], 0);
  const base = s.size / 4;
  assert.equal(buf.f32[base], 1.5);
  assert.equal(buf.u32[base + 1], 7);
  assert.deepEqual([...buf.f32.slice(base + 4, base + 7)], [1, 2, 3]);
  const mo = s.offsets.m / 4;
  assert.deepEqual(
    [...buf.f32.slice(mo, mo + 12)],
    [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0],
  );
});

test('rng is deterministic and in range', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 1000; i++) {
    const x = a.float();
    assert.equal(x, b.float());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(new Rng(1).float(), new Rng(2).float());
  const f1 = new Rng(5).fork('coral').float();
  const f2 = new Rng(5).fork('coral').float();
  assert.equal(f1, f2);
  const r = new Rng(9);
  for (let i = 0; i < 200; i++) {
    const n = r.int(3, 6);
    assert.ok(n >= 3 && n <= 6 && Number.isInteger(n));
  }
});

test('reversed-Z perspective maps near to 1 and far toward 0', () => {
  const p = mat4.perspectiveReversedZ(Math.PI / 2, 1, 0.1);
  assert.ok(Math.abs(mat4.transformPoint(p, [0, 0, -0.1])[2] - 1) < 1e-6);
  assert.ok(mat4.transformPoint(p, [0, 0, -1000])[2] < 1e-3);
  const o = mat4.orthoReversedZ(-1, 1, -1, 1, 1, 11);
  assert.ok(Math.abs(mat4.transformPoint(o, [0, 0, -1])[2] - 1) < 1e-6);
  assert.ok(Math.abs(mat4.transformPoint(o, [0, 0, -11])[2]) < 1e-6);
});

test('mat4 invert round-trips', () => {
  const v = mat4.lookAt([3, 4, 5], [0, 1, 0], [0, 1, 0]);
  const p = mat4.perspectiveReversedZ(1, 1.5, 0.1);
  const vp = mat4.multiply(p, v);
  const inv = mat4.invert(vp);
  const id = mat4.multiply(vp, inv);
  for (let i = 0; i < 16; i++) {
    assert.ok(
      Math.abs(id[i] - (i % 5 === 0 ? 1 : 0)) < 1e-4,
      `m[${i}]=${id[i]}`,
    );
  }
});
