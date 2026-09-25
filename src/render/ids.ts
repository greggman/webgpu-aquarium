// Object IDs: the opaque pass writes one r32uint per pixel saying what drew
// it, so passes after it can treat fish, reef and ground differently, the way
// a compositor grades a film frame with ID mattes.
//
// Bits: category (4) | type (12) | instance (16). Most passes only need the
// category; the type is the specific kind within it (a fish species, a mesh
// variant) and the instance is which one (for fish, its index in the sim).
// Type and instance are stored plus one, so 0 in either field means "not
// given": terrain has no type, and props have no stable instance (they are
// culled and repacked every frame). An ID of 0 is open water.

export const ID_FORMAT: GPUTextureFormat = 'r32uint';

export const Category = {
  /** Open water: nothing drawn (the target clears to 0). */
  Water: 0,
  Ground: 1,
  Rock: 2,
  Coral: 3,
  Fan: 4,
  Plant: 5,
  Seagrass: 6,
  Critter: 7,
  Fish: 8,
} as const;
export type Category = (typeof Category)[keyof typeof Category];

export const idWgsl = /* wgsl */ `
${Object.entries(Category)
  .map(([k, v]) => `const CAT_${k.toUpperCase()} = ${v}u;`)
  .join('\n')}

/** An ID with only a category. */
fn idOf(category: u32) -> u32 {
  return category << 28u;
}
/** An ID with a category and a 0-based type (below 4095). */
fn idOfType(category: u32, kind: u32) -> u32 {
  return idOf(category) | ((min(kind, 4094u) + 1u) << 16u);
}
/** An ID with a category, a type and a 0-based instance (below 65535). */
fn idOfInstance(category: u32, kind: u32, instance: u32) -> u32 {
  return idOfType(category, kind) | (min(instance, 65534u) + 1u);
}
fn idCategory(id: u32) -> u32 {
  return id >> 28u;
}
/** The 0-based type, or -1 when none was given. */
fn idType(id: u32) -> i32 {
  return i32((id >> 16u) & 0xfffu) - 1;
}
/** The 0-based instance, or -1 when none was given. */
fn idInstance(id: u32) -> i32 {
  return i32(id & 0xffffu) - 1;
}
`;
