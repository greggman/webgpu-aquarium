// Per-frame globals shared by every render shader (bind group 0).

import {defineStruct, StructBuffer} from '../gpu/structs.ts';

export const FrameStruct = defineStruct('Frame', {
  view: 'mat4x4f',
  proj: 'mat4x4f',
  viewProj: 'mat4x4f',
  invViewProj: 'mat4x4f',
  /** Unjittered view-projection of this frame and the previous one (for motion vectors). */
  viewProjNoJitter: 'mat4x4f',
  prevViewProjNoJitter: 'mat4x4f',
  shadowViewProj: 'mat4x4f',
  camPos: 'vec3f',
  time: 'f32',
  /** Direction toward the sun, in water (already refracted). */
  sunDir: 'vec3f',
  frameIndex: 'u32',
  sunColor: 'vec3f',
  exposure: 'f32',
  absorption: 'vec3f',
  scattering: 'f32',
  ambientColor: 'vec3f',
  surfaceY: 'f32',
  resolution: 'vec2f',
  jitter: 'vec2f',
  /** x: world scale (m per tile), y: intensity, z: depth where caustics fade, w: mip bias. */
  caustics: 'vec4f',
  /** x: world size (m), y: texels, z: min height, w: max height. */
  terrain: 'vec4f',
  /** x: shadow texel size (world m), y: shadow map resolution, z/w: unused. */
  shadow: 'vec4f',
  /** x: dt, y: tier (0 mobile .. 3 ultra), z: fog scale, w: wave phase seed. */
  misc: 'vec4f',
  /** Surface waves: (k.x, k.z, amplitude, angular frequency). Tile every caustics.x metres. */
  waves: 'array<vec4f, 12>',
});

export type FrameBuffer = StructBuffer<typeof FrameStruct.fields>;

export interface Globals {
  layout: GPUBindGroupLayout;
  buffer: GPUBuffer;
  data: FrameBuffer;
  samplers: {
    linearRepeat: GPUSampler;
    linearClamp: GPUSampler;
    shadow: GPUSampler;
    nearestClamp: GPUSampler;
  };
}

/**
 * Bind group 0 layout:
 *   0 Frame uniform
 *   1 linear/repeat sampler     2 linear/clamp sampler
 *   3 shadow depth texture      4 shadow comparison sampler
 *   5 caustics texture (rgba16float, mipmapped, repeat)
 *   6 detail noise texture (rgba16float for smooth bump gradients, mipmapped, repeat)
 *   7 terrain texture (rgba16float: height, normal.x, normal.z, ao)
 *   8 terrain material masks (rgba8unorm)
 */
export function createGlobals(device: GPUDevice): Globals {
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const layout = device.createBindGroupLayout({
    label: 'globals:bgl',
    entries: [
      {
        binding: 0,
        visibility: VF | GPUShaderStage.COMPUTE,
        buffer: {type: 'uniform', minBindingSize: FrameStruct.size},
      },
      {binding: 1, visibility: VF, sampler: {type: 'filtering'}},
      {binding: 2, visibility: VF, sampler: {type: 'filtering'}},
      {binding: 3, visibility: VF, texture: {sampleType: 'depth'}},
      {binding: 4, visibility: VF, sampler: {type: 'comparison'}},
      {binding: 5, visibility: VF, texture: {sampleType: 'float'}},
      {binding: 6, visibility: VF, texture: {sampleType: 'float'}},
      {binding: 7, visibility: VF, texture: {sampleType: 'float'}},
      {binding: 8, visibility: VF, texture: {sampleType: 'float'}},
    ],
  });
  const buffer = device.createBuffer({
    label: 'globals:frame-uniform',
    size: FrameStruct.size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const samplers = {
    linearRepeat: device.createSampler({
      label: 'globals:sampler-linear-repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 8,
    }),
    linearClamp: device.createSampler({
      label: 'globals:sampler-linear-clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    }),
    shadow: device.createSampler({
      label: 'globals:sampler-shadow',
      magFilter: 'linear',
      minFilter: 'linear',
      // Reversed-Z: closer to the light means a larger depth value.
      compare: 'greater-equal',
    }),
    nearestClamp: device.createSampler({
      label: 'globals:sampler-nearest-clamp',
    }),
  };
  return {layout, buffer, data: new StructBuffer(FrameStruct), samplers};
}

export interface GlobalTextures {
  shadow: GPUTexture;
  caustics: GPUTexture;
  detail: GPUTexture;
  terrain: GPUTexture;
  terrainMask: GPUTexture;
}

export function createGlobalsBindGroup(
  device: GPUDevice,
  g: Globals,
  t: GlobalTextures,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'globals:bind-group',
    layout: g.layout,
    entries: [
      {binding: 0, resource: {buffer: g.buffer}},
      {binding: 1, resource: g.samplers.linearRepeat},
      {binding: 2, resource: g.samplers.linearClamp},
      {
        binding: 3,
        resource: t.shadow.createView({label: 'globals:shadow-view'}),
      },
      {binding: 4, resource: g.samplers.shadow},
      {
        binding: 5,
        resource: t.caustics.createView({label: 'globals:caustics-view'}),
      },
      {
        binding: 6,
        resource: t.detail.createView({label: 'globals:detail-view'}),
      },
      {
        binding: 7,
        resource: t.terrain.createView({label: 'globals:terrain-view'}),
      },
      {
        binding: 8,
        resource: t.terrainMask.createView({
          label: 'globals:terrain-mask-view',
        }),
      },
    ],
  });
}
