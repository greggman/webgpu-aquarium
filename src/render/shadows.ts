// Sun shadow map: an orthographic view along the (refracted) sun direction,
// centred ahead of the camera and snapped to texels so shadows don't swim.

import * as mat4 from '../math/mat4.ts';
import * as vec3 from '../math/vec3.ts';
import type {Vec3} from '../math/vec3.ts';

export class SunShadow {
  readonly texture: GPUTexture;
  readonly size: number;
  readonly extent: number;
  readonly viewProj = mat4.create();
  private view = mat4.create();
  private proj = mat4.create();

  constructor(device: GPUDevice, size: number, extent: number) {
    this.size = size;
    this.extent = extent;
    this.texture = device.createTexture({
      label: 'shadow:map',
      size: [size, size],
      format: 'depth32float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  /** World-space size of one shadow texel. */
  get texelWorld() {
    return (this.extent * 2) / this.size;
  }

  update(
    camPos: Readonly<Vec3>,
    forward: Readonly<Vec3>,
    sunDir: Readonly<Vec3>,
    surfaceY: number,
  ) {
    // Centre the map a little ahead of the camera, on the horizontal plane.
    const flat = vec3.normalize([forward[0], 0, forward[2]]);
    const center: Vec3 = [
      camPos[0] + flat[0] * this.extent * 0.45,
      camPos[1] - 4,
      camPos[2] + flat[2] * this.extent * 0.45,
    ];
    const up: Vec3 = Math.abs(sunDir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    // Build a light basis at the origin and snap the centre in light space.
    mat4.lookAt([0, 0, 0], vec3.scale(sunDir, -1), up, this.view);
    const lc = mat4.transformPoint(this.view, center);
    const texel = this.texelWorld;
    lc[0] = Math.round(lc[0] / texel) * texel;
    lc[1] = Math.round(lc[1] / texel) * texel;
    // Put the near plane at the water surface along the light direction.
    const distToSurface = (surfaceY - center[1]) / Math.max(sunDir[1], 0.2) + 2;
    const near = -lc[2] - distToSurface;
    const far = -lc[2] + 60;
    mat4.orthoReversedZ(
      lc[0] - this.extent,
      lc[0] + this.extent,
      lc[1] - this.extent,
      lc[1] + this.extent,
      near,
      far,
      this.proj,
    );
    mat4.multiply(this.proj, this.view, this.viewProj);
  }
}
