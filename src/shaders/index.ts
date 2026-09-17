// WGSL chunks, assembled into complete shaders by concatenation.

import {FrameStruct} from '../render/globals.ts';
import noise from './noise.wgsl';
import water from './water.wgsl';
import lighting from './lighting.wgsl';
import wavesChunk from './waves.wgsl';

export {noise, water, lighting};

/** Waves driven by the frame uniform. */
export const waves = /* wgsl */ `
fn waveData(i: u32) -> vec4f { return frame.waves[i]; }
fn wavePhaseSeed() -> f32 { return frame.misc.w; }
${wavesChunk}
`;

/** Frame struct + bind group 0 declarations. */
export const globals = /* wgsl */ `
${FrameStruct.wgsl}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var sLinearRepeat: sampler;
@group(0) @binding(2) var sLinearClamp: sampler;
@group(0) @binding(3) var tShadow: texture_depth_2d;
@group(0) @binding(4) var sShadow: sampler_comparison;
@group(0) @binding(5) var tCaustics: texture_2d<f32>;
@group(0) @binding(6) var tDetail: texture_2d<f32>;
@group(0) @binding(7) var tTerrain: texture_2d<f32>;
@group(0) @binding(8) var tTerrainMask: texture_2d<f32>;
@group(0) @binding(9) var tContact: texture_2d<f32>;

/**
 * How far a fragment moved on screen since the last frame, for TAA.
 *
 * A point that is in front of the camera now may have been behind it last
 * frame, and then its previous w is zero or negative and the perspective
 * divide means nothing: the answer runs off to infinity, or is a plain
 * division by zero. TAA has no defence against that — its bounds test is a
 * pair of comparisons that are both false for a NaN, so the bad value passes
 * the test, skips the neighbourhood clip, and is written into the history,
 * where it is read back and rewritten every frame after. One fragment latches
 * a texel permanently. Report no motion instead; a point that was off-screen
 * has no usable history anyway.
 */
fn screenVelocity(cur: vec4f, prev: vec4f) -> vec2f {
  if (cur.w <= 0.0 || prev.w <= 0.0) {
    return vec2f(0.0);
  }
  return (cur.xy / cur.w - prev.xy / prev.w) * vec2f(0.5, -0.5);
}
`;

/** Everything a lit surface shader needs. */
export const surfaceLib = [globals, noise, waves, water, lighting].join('\n');

/** Fullscreen triangle vertex shader (outputs uv with y down). */
export const fullscreenVS = /* wgsl */ `
struct FSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsFullscreen(@builtin(vertex_index) i: u32) -> FSOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FSOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;
