// Draws open water wherever no geometry was rendered.

import {createShader} from '../gpu/device.ts';
import {ID_FORMAT} from './ids.ts';
import {fullscreenVS, globals, noise, water, waves} from '../shaders/index.ts';
import {
  DEPTH_FORMAT,
  HDR_FORMAT,
  VELOCITY_FORMAT,
  type RenderSystem,
} from './renderer.ts';

const shader = /* wgsl */ `
${globals}
${noise}
${waves}
${water}
${fullscreenVS}

struct FOut {
  @location(0) color: vec4f,
  @location(1) velocity: vec2f,
  @location(2) id: u32,
};

@fragment
fn fs(i: FSOut) -> FOut {
  let ndc = vec2f(i.uv.x * 2.0 - 1.0, 1.0 - i.uv.y * 2.0);
  // A point far along the view ray (reversed-Z: small depth is far away).
  let h = frame.invViewProj * vec4f(ndc, 1e-3, 1.0);
  let dir = normalize(h.xyz / h.w - frame.camPos);
  var o: FOut;
  let dither = (ign(i.pos.xy, frame.frameIndex) - 0.5) / 255.0;
  o.color = vec4f(waterBackground(dir) + dither, 1.0);
  let cur = frame.viewProjNoJitter * vec4f(dir, 0.0);
  let prev = frame.prevViewProjNoJitter * vec4f(dir, 0.0);
  o.velocity = (cur.xy / cur.w - prev.xy / prev.w) * vec2f(0.5, -0.5);
  o.id = idOf(CAT_WATER);
  return o;
}
`;

export async function createBackground(
  device: GPUDevice,
  globalsLayout: GPUBindGroupLayout,
): Promise<RenderSystem> {
  const module = createShader(device, 'background:shader', shader);
  const pipeline = await device.createRenderPipelineAsync({
    label: 'background:pipeline',
    layout: device.createPipelineLayout({
      label: 'background:pipeline-layout',
      bindGroupLayouts: [globalsLayout],
    }),
    vertex: {module, entryPoint: 'vsFullscreen'},
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        {format: HDR_FORMAT},
        {format: VELOCITY_FORMAT},
        {format: ID_FORMAT},
      ],
    },
    // Only where the depth buffer is still clear (reversed-Z far = 0).
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: 'equal',
    },
  });
  return {
    name: 'background',
    drawOpaque(pass) {
      pass.setPipeline(pipeline);
      pass.draw(3);
    },
  };
}
