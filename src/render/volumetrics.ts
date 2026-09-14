// Volumetric sun shafts. A low-resolution compute raymarch accumulates sunlight
// scattered toward the camera, modulated by the shadow map and by the caustic
// pattern at the point where each sample's sunlight entered the water - that
// modulation is what turns uniform haze into god rays. A temporal filter
// removes the raymarch noise and a depth-aware upsample composites it.

import {createShader} from '../gpu/device.ts';
import {fullscreenVS, globals, noise, waves, water} from '../shaders/index.ts';
import {
  HDR_FORMAT,
  type FrameContext,
  type Renderer,
  type RenderSystem,
  type Targets,
} from './renderer.ts';
import type {Quality} from '../core/quality.ts';

const NEAR = 0.05;

const marchShader = /* wgsl */ `
${globals}
${noise}
${waves}
${water}

struct VolParams {
  steps: u32,
  maxDist: f32,
  strength: f32,
  historyWeight: f32,
};
@group(1) @binding(0) var tDepth: texture_depth_2d;
@group(1) @binding(1) var tHistory: texture_2d<f32>;
@group(1) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var<uniform> V: VolParams;

fn shadowTap(p: vec3f) -> f32 {
  let clip = frame.shadowViewProj * vec4f(p, 1.0);
  let uv = clip.xy * vec2f(0.5, -0.5) + 0.5;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || clip.z < 0.0 || frame.shadow.x <= 0.0) {
    return 1.0;
  }
  // Fade toward unshadowed at the map's border so its edge never shows.
  let edge = smoothstep(0.0, 0.15, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
  return mix(1.0, textureSampleCompareLevel(tShadow, sShadow, uv, clip.z), edge);
}

fn beam(p: vec3f) -> f32 {
  let depth = depthBelowSurface(p.y);
  let t = depth / max(frame.sunDir.y, 0.25);
  let entry = p.xz + frame.sunDir.xz * t;
  // Shafts are the caustic pattern seen edge-on. Sample it large and blurry so
  // the shafts are broad and soft (a fine pattern aliases into a comb), and
  // gate it with slow, large-scale noise so shafts come in groups with dark
  // gaps between them.
  let rot = mat2x2f(0.8, 0.6, -0.6, 0.8);
  let uvc = entry / (frame.caustics.x * 2.2);
  // A constant blur level keeps each shaft continuous from top to bottom.
  let lod = 3.5;
  let c = sqrt(
    textureSampleLevel(tCaustics, sLinearRepeat, uvc, lod).g *
    textureSampleLevel(tCaustics, sLinearRepeat, rot * uvc * 0.61 + 0.31, lod).g,
  );
  // Normalise by the average brightness so contrast is independent of the mip.
  let avg = textureSampleLevel(tCaustics, sLinearRepeat, uvc, 9.0).g;
  let rel = c / max(avg, 1e-3);
  // A much larger, blurrier sample of the same pattern clusters the shafts:
  // some bundles bright and broad, others thin or missing, never an even comb.
  let cluster = textureSampleLevel(tCaustics, sLinearRepeat, rot * entry / (frame.caustics.x * 9.0) + 0.17, 5.0).g / max(avg, 1e-3);
  let bundle = smoothstep(0.5, 1.3, cluster);
  // Slow drifting gate from the tileable detail noise (cheap: one sample).
  let drift = vec2f(frame.time * 0.15, frame.time * 0.07);
  let broad = textureSampleLevel(tDetail, sLinearRepeat, (entry + drift) / 90.0, 2.0).r;
  let gate = smoothstep(0.42, 0.68, broad);
  // Brightest just under the surface, fading as the beams spread with depth.
  let taper = 0.35 + 0.65 * exp(-depth * 0.06);
  // A low sun drives long slanted shafts through the whole view: thin them out
  // so they don't become an evenly striped curtain.
  let lowSun = mix(0.45, 1.0, smoothstep(0.7, 0.92, frame.sunDir.y));
  // Roll off the brightest focal lines so no single shaft becomes a laser.
  let peak = pow(rel, 4.0);
  return peak / (1.0 + peak * 0.03) * gate * mix(0.45, 2.1, bundle) * taper * lowSun * 1.6;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let outSize = textureDimensions(dst);
  if (any(id.xy >= outSize)) {
    return;
  }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(outSize);
  let depthSize = vec2f(textureDimensions(tDepth));
  let d = textureLoad(tDepth, vec2i(uv * depthSize), 0);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let farH = frame.invViewProj * vec4f(ndc, 1e-3, 1.0);
  let dir = normalize(farH.xyz / farH.w - frame.camPos);

  var dist = V.maxDist;
  if (d > 0.0) {
    let h = frame.invViewProj * vec4f(ndc, d, 1.0);
    dist = min(length(h.xyz / h.w - frame.camPos), V.maxDist);
  }
  if (dir.y > 0.0) {
    dist = min(dist, (frame.surfaceY - frame.camPos.y) / dir.y);
  }

  let jitter = ign(vec2f(id.xy), frame.frameIndex);
  let n = V.steps;
  // Spend more samples near the camera where shafts are most visible.
  var accum = vec3f(0.0);
  // Shafts fade out faster than the fog so distant ones don't read as pillars.
  let ext = extinction() * frame.misc.z * 2.2;
  var prevT = 0.0;
  for (var i = 0u; i < n; i++) {
    let f = (f32(i) + jitter) / f32(n);
    let t = f * f * dist;
    let p = frame.camPos + dir * t;
    let dt = max(t - prevT, 0.0) + dist / f32(n * n);
    prevT = t;
    // Distant shafts fade out smoothly (sparse far samples would band).
    // ...and the first metres are thinned so a shaft the camera sits in
    // doesn't lay a milky veil over the whole foreground.
    let far = smoothstep(32.0, 10.0, t) * mix(0.25, 1.0, smoothstep(0.5, 5.0, t));
    let light = sunAtDepth(p.y) * shadowTap(p) * beam(p) * far;
    accum += light * exp(-ext * t) * dt;
  }
  // Cap the forward peak so looking toward the sun doesn't wash out the frame.
  // A floor keeps shafts readable when looking away from the sun, as games do.
  let phase = 0.06 + min(waterPhase(dot(dir, frame.sunDir)), 0.3) * 0.6;
  // Shafts take on the water's hue (light scattered on its way down), so a
  // warm sun gives golden-teal beams rather than grey-yellow smog.
  let waterHue = frame.ambientColor / max(dot(frame.ambientColor, vec3f(0.2126, 0.7152, 0.0722)), 1e-3);
  let tint = mix(vec3f(1.0), waterHue, 0.45);
  let raw = accum * tint * frame.scattering * phase * V.strength;
  // Soft clamp: bright shafts roll off instead of blowing the frame out.
  // Seen from above, shafts are edge-on columns that only add a milky smear
  // over the seabed; fade them when looking down.
  let lookDown = mix(0.2, 1.0, smoothstep(-0.85, -0.1, dir.y));
  let current = raw * lookDown / (1.0 + dot(raw, vec3f(0.2126, 0.7152, 0.0722)) * 1.2);

  // Temporal accumulation with reprojection of a representative point.
  let rep = frame.camPos + dir * min(dist, 12.0);
  let prevClip = frame.prevViewProjNoJitter * vec4f(rep, 1.0);
  let prevUv = prevClip.xy / prevClip.w * vec2f(0.5, -0.5) + 0.5;
  var result = current;
  if (all(prevUv > vec2f(0.0)) && all(prevUv < vec2f(1.0))) {
    let hist = textureSampleLevel(tHistory, sLinearClamp, prevUv, 0.0).rgb;
    result = mix(current, hist, V.historyWeight);
  }
  let viewDist = select(1e4, ${NEAR} / max(d, 1e-7), d > 0.0);
  textureStore(dst, id.xy, vec4f(result, viewDist));
}
`;

const compositeShader = /* wgsl */ `
${fullscreenVS}
@group(0) @binding(0) var tVol: texture_2d<f32>;
@group(0) @binding(1) var tDepth: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;

@fragment
fn fs(i: FSOut) -> @location(0) vec4f {
  let d = textureLoad(tDepth, vec2i(i.pos.xy), 0);
  let viewDist = select(1e4, ${NEAR} / max(d, 1e-7), d > 0.0);
  let volSize = vec2f(textureDimensions(tVol));
  let texel = 1.0 / volSize;
  let base = i.uv * volSize - 0.5;
  let f = fract(base);
  let origin = (floor(base) + 0.5) * texel;
  // Tent-filtered 3x3 gather over the coarse texels (this also smooths the
  // raymarch's residual banding), reweighted by how well each depth matches.
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var y = -1; y <= 2; y++) {
    for (var x = -1; x <= 2; x++) {
      let uv = origin + vec2f(f32(x), f32(y)) * texel;
      let s = textureSampleLevel(tVol, samp, uv, 0.0);
      // Tent of radius 1.5 texels around this pixel's position between texels.
      let tent = max(1.5 - abs(f32(x) - f.x), 0.0) * max(1.5 - abs(f32(y) - f.y), 0.0);
      let dw = 1.0 / (1e-3 + abs(log(s.a / viewDist)) * 8.0);
      let w = tent * dw + 1e-5;
      sum += s.rgb * w;
      wsum += w;
    }
  }
  return vec4f(sum / wsum, 0.0);
}
`;

export async function createVolumetrics(
  renderer: Renderer,
  quality: Quality,
): Promise<RenderSystem> {
  const device = renderer.device;
  const divisor =
    quality.volumetrics === 'high'
      ? 2
      : quality.volumetrics === 'medium'
        ? 3
        : 4;
  const marchModule = createShader(
    device,
    'volumetrics:march-shader',
    marchShader,
  );
  const marchPipeline = await device.createComputePipelineAsync({
    label: 'volumetrics:march-pipeline',
    layout: 'auto',
    compute: {module: marchModule, entryPoint: 'main'},
  });
  const compModule = createShader(
    device,
    'volumetrics:composite-shader',
    compositeShader,
  );
  const compPipeline = await device.createRenderPipelineAsync({
    label: 'volumetrics:composite-pipeline',
    layout: 'auto',
    vertex: {module: compModule, entryPoint: 'vsFullscreen'},
    fragment: {
      module: compModule,
      entryPoint: 'fs',
      targets: [
        {
          format: HDR_FORMAT,
          blend: {
            color: {srcFactor: 'one', dstFactor: 'one', operation: 'add'},
            alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'},
          },
        },
      ],
    },
  });
  const params = device.createBuffer({
    label: 'volumetrics:params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const paramData = new ArrayBuffer(16);
  new Uint32Array(paramData, 0, 1)[0] = quality.volumetricSteps;
  const tune = Number(new URLSearchParams(location.search).get('vol') ?? 1);
  new Float32Array(paramData, 4, 3).set([70, 0.3 * tune, 0.88]);
  device.queue.writeBuffer(params, 0, paramData);

  const sampler = device.createSampler({
    label: 'volumetrics:sampler',
    magFilter: 'linear',
    minFilter: 'linear',
  });

  let textures: GPUTexture[] = [];
  let marchGlobals: GPUBindGroup;
  let marchGroups: GPUBindGroup[] = [];
  let compGroups: GPUBindGroup[] = [];
  let current = 0;
  let size: [number, number] = [1, 1];
  let lastGlobals: GPUBindGroup | null = null;

  const makeGlobals = () => {
    const g = renderer.globals;
    const t = renderer.textures;
    marchGlobals = device.createBindGroup({
      label: 'volumetrics:globals-bind-group',
      layout: marchPipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: {buffer: g.buffer}},
        {binding: 1, resource: g.samplers.linearRepeat},
        {binding: 2, resource: g.samplers.linearClamp},
        {
          binding: 3,
          resource: t.shadow.createView({label: 'volumetrics:shadow-view'}),
        },
        {binding: 4, resource: g.samplers.shadow},
        {
          binding: 5,
          resource: t.caustics.createView({label: 'volumetrics:caustics-view'}),
        },
        {
          binding: 6,
          resource: t.detail.createView({label: 'volumetrics:detail-view'}),
        },
      ],
    });
  };

  const system: RenderSystem = {
    name: 'volumetrics',
    resize(targets: Targets) {
      textures.forEach(t => t.destroy());
      size = [
        Math.max(1, Math.ceil(targets.width / divisor)),
        Math.max(1, Math.ceil(targets.height / divisor)),
      ];
      textures = [0, 1].map(i =>
        device.createTexture({
          label: `volumetrics:buffer-${i}`,
          size,
          format: 'rgba16float',
          usage:
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        }),
      );
      const depthView = targets.depth.createView({
        label: 'volumetrics:depth-view',
      });
      marchGroups = [0, 1].map(i =>
        device.createBindGroup({
          label: `volumetrics:march-bind-group-${i}`,
          layout: marchPipeline.getBindGroupLayout(1),
          entries: [
            {binding: 0, resource: depthView},
            {
              binding: 1,
              resource: textures[1 - i].createView({
                label: `volumetrics:history-view-${i}`,
              }),
            },
            {
              binding: 2,
              resource: textures[i].createView({
                label: `volumetrics:out-view-${i}`,
              }),
            },
            {binding: 3, resource: {buffer: params}},
          ],
        }),
      );
      compGroups = [0, 1].map(i =>
        device.createBindGroup({
          label: `volumetrics:composite-bind-group-${i}`,
          layout: compPipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: textures[i].createView({
                label: `volumetrics:composite-src-${i}`,
              }),
            },
            {binding: 1, resource: depthView},
            {binding: 2, resource: sampler},
          ],
        }),
      );
    },
    afterOpaque(ctx: FrameContext) {
      if (lastGlobals !== ctx.globals) {
        lastGlobals = ctx.globals;
        makeGlobals();
      }
      current = 1 - current;
      const cpass = ctx.encoder.beginComputePass({
        label: 'volumetrics:march-pass',
      });
      cpass.setPipeline(marchPipeline);
      cpass.setBindGroup(0, marchGlobals);
      cpass.setBindGroup(1, marchGroups[current]);
      cpass.dispatchWorkgroups(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
      cpass.end();

      const pass = ctx.encoder.beginRenderPass({
        label: 'volumetrics:composite-pass',
        colorAttachments: [
          {view: ctx.targets.color, loadOp: 'load', storeOp: 'store'},
        ],
      });
      pass.setPipeline(compPipeline);
      pass.setBindGroup(0, compGroups[current]);
      pass.draw(3);
      pass.end();
    },
  };
  return system;
}
