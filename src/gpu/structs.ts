// Single-source GPU struct definitions.
//
// A struct is declared once in TypeScript. From that we derive:
//   - the WGSL `struct` source that shaders include,
//   - byte offsets for every field (following WGSL alignment rules),
//   - the total size, used as `minBindingSize` in bind group layouts so a
//     buffer/layout mismatch becomes a validation error instead of garbage.

export type WgslScalar = 'f32' | 'i32' | 'u32';
export type WgslType =
  | WgslScalar
  | 'vec2f'
  | 'vec3f'
  | 'vec4f'
  | 'vec2u'
  | 'vec3u'
  | 'vec4u'
  | 'vec2i'
  | 'vec3i'
  | 'vec4i'
  | 'mat3x3f'
  | 'mat4x4f'
  | `array<${string}, ${number}>`;

interface TypeInfo {
  align: number;
  size: number;
}

const BASIC: Record<string, TypeInfo> = {
  f32: {align: 4, size: 4},
  i32: {align: 4, size: 4},
  u32: {align: 4, size: 4},
  vec2f: {align: 8, size: 8},
  vec2i: {align: 8, size: 8},
  vec2u: {align: 8, size: 8},
  vec3f: {align: 16, size: 12},
  vec3i: {align: 16, size: 12},
  vec3u: {align: 16, size: 12},
  vec4f: {align: 16, size: 16},
  vec4i: {align: 16, size: 16},
  vec4u: {align: 16, size: 16},
  mat3x3f: {align: 16, size: 48},
  mat4x4f: {align: 16, size: 64},
};

const roundUp = (align: number, n: number) => Math.ceil(n / align) * align;

export function typeInfo(type: string): TypeInfo {
  const basic = BASIC[type];
  if (basic) {
    return basic;
  }
  const m = /^array<\s*(\w+)\s*,\s*(\d+)\s*>$/.exec(type);
  if (m) {
    const elem = typeInfo(m[1]);
    return {
      align: elem.align,
      size: Number(m[2]) * roundUp(elem.align, elem.size),
    };
  }
  throw new Error(`unsupported WGSL type: ${type}`);
}

export interface StructDef<F extends Record<string, WgslType>> {
  name: string;
  fields: F;
  /** Byte offset of each field. */
  offsets: {[K in keyof F]: number};
  size: number;
  align: number;
  wgsl: string;
}

export function defineStruct<F extends Record<string, WgslType>>(
  name: string,
  fields: F,
): StructDef<F> {
  let offset = 0;
  let align = 1;
  const offsets = {} as {[K in keyof F]: number};
  const lines: string[] = [];
  for (const key of Object.keys(fields) as (keyof F & string)[]) {
    const info = typeInfo(fields[key]);
    offset = roundUp(info.align, offset);
    offsets[key] = offset;
    offset += info.size;
    align = Math.max(align, info.align);
    lines.push(`  ${key}: ${fields[key]},`);
  }
  const size = roundUp(align, offset);
  return {
    name,
    fields,
    offsets,
    size,
    align,
    wgsl: `struct ${name} {\n${lines.join('\n')}\n};\n`,
  };
}

/**
 * CPU-side mirror of a struct (or array of structs) backed by an ArrayBuffer,
 * with typed views for writing fields by name.
 */
export class StructBuffer<F extends Record<string, WgslType>> {
  readonly data: ArrayBuffer;
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
  readonly i32: Int32Array;
  readonly def: StructDef<F>;
  readonly count: number;

  constructor(def: StructDef<F>, count = 1) {
    this.def = def;
    this.count = count;
    this.data = new ArrayBuffer(def.size * count);
    this.f32 = new Float32Array(this.data);
    this.u32 = new Uint32Array(this.data);
    this.i32 = new Int32Array(this.data);
  }

  /** Writes a field of element `index`. Numbers write per the field's scalar kind. */
  set(field: keyof F & string, value: number | ArrayLike<number>, index = 0) {
    const type = this.def.fields[field];
    const base = (index * this.def.size + this.def.offsets[field]) / 4;
    const elem = /^array<\s*(\w+)/.exec(type)?.[1] ?? type;
    const kind = /^(u32|vec\du)$/.test(elem)
      ? 'u'
      : /^(i32|vec\di)$/.test(elem)
        ? 'i'
        : 'f';
    const view = kind === 'u' ? this.u32 : kind === 'i' ? this.i32 : this.f32;
    if (typeof value === 'number') {
      view[base] = value;
    } else if (type === 'mat3x3f') {
      // Accept 9 values (column-major) and insert the padding.
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < 3; r++) {
          view[base + c * 4 + r] = value[c * 3 + r];
        }
      }
    } else {
      for (let i = 0; i < value.length; i++) {
        view[base + i] = value[i];
      }
    }
  }
}
