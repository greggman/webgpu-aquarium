// Grade: the set's colour script and depth staging, applied once per pixel
// after the opaque pass, using the ID target to tell what drew each pixel —
// the way a compositor grades a film frame with ID mattes. Fish and open
// water pass through untouched; everything else is the set.
//
// It runs before TAA, so the hard per-pixel edges of the ID target are
// smoothed like any other edge, and before the transparent pass, so particles
// drifting over the reef are not graded as reef.
//
// ?ids=1 shows the categories in false colour instead.

import {createShader} from '../gpu/device.ts';
import {fullscreenVS, surfaceLib} from '../shaders/index.ts';
import {HDR_FORMAT, type Renderer, type RenderSystem} from './renderer.ts';

const shader = (showIds: boolean) => /* wgsl */ `
${surfaceLib}
${fullscreenVS}
@group(1) @binding(0) var tSrc: texture_2d<f32>;
@group(1) @binding(1) var tId: texture_2d<u32>;
@group(1) @binding(2) var tDepth: texture_depth_2d;

fn falseColor(cat: u32) -> vec3f {
  var c = array<vec3f, 9>(
    vec3f(0.0, 0.0, 0.1), vec3f(0.6, 0.5, 0.3), vec3f(0.4, 0.4, 0.4),
    vec3f(1.0, 0.3, 0.5), vec3f(0.8, 0.2, 1.0), vec3f(0.2, 0.8, 0.2),
    vec3f(0.6, 1.0, 0.4), vec3f(1.0, 0.8, 0.0), vec3f(0.1, 0.6, 1.0),
  );
  return c[min(cat, 8u)];
}

@fragment
fn fs(i: FSOut) -> @location(0) vec4f {
  let px = vec2i(i.pos.xy);
  let c = textureLoad(tSrc, px, 0);
  let id = textureLoad(tId, px, 0).r;
  let cat = idCategory(id);
${
  showIds
    ? `  let shade = 0.5 + 0.5 * fract(f32(idType(id) + 1) * 0.618);
  return vec4f(falseColor(cat) * shade, 1.0);`
    : `  if (cat == CAT_WATER || cat == CAT_FISH) {
    return c;
  }
  let ndc = vec2f(i.uv.x * 2.0 - 1.0, 1.0 - i.uv.y * 2.0);
  let h = frame.invViewProj * vec4f(ndc, textureLoad(tDepth, px, 0), 1.0);
  let p = h.xyz / h.w;
  // Undo the water exactly as applyWater laid it on (lit * T + fog), grade
  // the surface's own light, and put the water back, so the water's colour
  // is never pulled toward the set's. Far out, where applyWater dissolves
  // the set into the backdrop, the pixel is water and is left alone.
  let toP = p - frame.camPos;
  let dist = length(toP);
  let typical = 1.0 / max(extinction().g, 1e-3);
  if (dist > typical * 1.4) {
    return c;
  }
  let dir = toP / max(dist, 1e-4);
  let T = max(waterTransmittance(dist), vec3f(0.02));
  let fog = inscatterColor(mix(frame.camPos.y, p.y, 0.5), dir) * (1.0 - T);
  let lit = max(c.rgb - fog, vec3f(0.0)) / T;
  return vec4f(recede(setDressing(lit), p) * T + fog, c.a);`
}
}
`;

export async function createGrade(
  renderer: Renderer,
  showIds: boolean,
): Promise<RenderSystem> {
  const device = renderer.device;
  const module = createShader(device, 'grade:shader', shader(showIds));
  const localLayout = device.createBindGroupLayout({
    label: 'grade:bgl',
    entries: [
      {binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {}},
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {sampleType: 'uint'},
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {sampleType: 'depth'},
      },
    ],
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'grade:pipeline',
    layout: device.createPipelineLayout({
      label: 'grade:pipeline-layout',
      bindGroupLayouts: [renderer.globals.layout, localLayout],
    }),
    vertex: {module, entryPoint: 'vsFullscreen'},
    fragment: {module, entryPoint: 'fs', targets: [{format: HDR_FORMAT}]},
  });

  // The pass writes the colour target, so it reads a copy of it.
  let copy: GPUTexture | null = null;
  let group: GPUBindGroup | null = null;
  return {
    name: 'grade',
    resize(t) {
      copy?.destroy();
      copy = device.createTexture({
        label: 'grade:copy',
        size: [t.width, t.height],
        format: HDR_FORMAT,
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      group = device.createBindGroup({
        label: 'grade:bind-group',
        layout: localLayout,
        entries: [
          {binding: 0, resource: copy.createView()},
          {binding: 1, resource: t.id.createView()},
          {binding: 2, resource: t.depth.createView()},
        ],
      });
    },
    afterOpaque(ctx) {
      if (!copy || !group) {
        return;
      }
      const t = ctx.targets;
      ctx.encoder.copyTextureToTexture({texture: t.color}, {texture: copy}, [
        t.width,
        t.height,
      ]);
      const pass = ctx.encoder.beginRenderPass({
        label: 'grade:pass',
        colorAttachments: [
          {view: t.color.createView(), loadOp: 'load', storeOp: 'store'},
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, ctx.globals);
      pass.setBindGroup(1, group);
      pass.draw(3);
      pass.end();
    },
  };
}
