import {
  initGPU,
  markReady,
  reportError,
  WebGPUUnavailableError,
} from './gpu/device.ts';
import {showUnsupported} from './gpu/unsupported.ts';
import {GpuProfiler} from './gpu/profiler.ts';
import {detectTier, getQuality, DynamicResolution} from './core/quality.ts';
import {Clock} from './core/clock.ts';
import * as mat4 from './math/mat4.ts';
import {Renderer} from './render/renderer.ts';
import {createBackground} from './render/background.ts';
import {createPresent} from './render/post/present.ts';
import {createDetailTexture} from './gen/textures.ts';
import {generateTerrain, createTerrainRenderer} from './gen/terrain.ts';
import {describeWorld, buildNavVolume, cameraSpots} from './world/world.ts';
import {Input} from './player/input.ts';
import {SwimCamera, viewMatrix, type CameraPose} from './player/camera.ts';
import {AttractTour} from './player/attract.ts';
import {Caustics, makeWaves, WAVE_TILE} from './render/caustics.ts';
import {createContactMap} from './render/contact.ts';
import {SunShadow} from './render/shadows.ts';
import {createVolumetrics} from './render/volumetrics.ts';
import {createSsao} from './render/ssao.ts';
import {createDof} from './render/post/dof.ts';
import {focusDistance} from './player/focus.ts';
import {AutoFocus} from './render/autofocus.ts';
import {createTaa, halton} from './render/post/taa.ts';
import {Bloom} from './render/post/bloom.ts';
import {forwardFromAngles} from './player/camera.ts';
import {createGenContext} from './world/layout.ts';
import {buildVoxelTerrain, createVoxelRenderer} from './gen/voxel.ts';
import {createRocks} from './gen/kinds/rocks.ts';
import {createCoral} from './gen/kinds/coral.ts';
import {createCritters} from './gen/kinds/critters.ts';
import {createPlants} from './gen/kinds/plants.ts';
import {createFish} from './sim/fish.ts';
import {CreatureCam} from './player/follow.ts';
import {createJellyfish} from './sim/jellyfish.ts';
import {createParticles} from './render/particles.ts';

const params = new URLSearchParams(location.search);
/** Systems whose opaque shaders use discard. */
const ALPHA_TESTED = new Set(['fans', 'fish']);
const numParam = (name: string) =>
  params.has(name) ? Number(params.get(name)) : null;

async function main() {
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const hud = document.getElementById('hud')!;
  // New ocean: reload, keeping any other URL options but dropping the seed so
  // a later refresh gives another one (the seed is random when unset).
  const regen = document.getElementById('regenerate') as HTMLButtonElement;
  if (params.get('hud') === '0') {
    regen.hidden = true;
  }
  regen.addEventListener('click', e => {
    e.stopPropagation();
    regen.disabled = true;
    const next = new URLSearchParams(location.search);
    next.delete('seed');
    const query = next.toString();
    const url = location.pathname + (query ? `?${query}` : '') + location.hash;
    if (url === location.pathname + location.search + location.hash) {
      location.reload();
    } else {
      location.replace(url);
    }
  });
  // Don't let presses on the button count as camera input.
  for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
    regen.addEventListener(type, e => e.stopPropagation());
  }
  const loading = document.getElementById('loading')!;

  const gpu = await initGPU(canvas);
  const {device} = gpu;
  // ?profile=gpu: per-pass GPU timings and triangle counts.
  const gpuProfiler =
    params.get('profile') === 'gpu' ? GpuProfiler.install(device) : null;
  window.__aquarium.gpuProfile = () => gpuProfiler?.summary() ?? null;
  const tier = detectTier(gpu.info, params.get('quality'));
  const quality = getQuality(tier);
  const seed = numParam('seed') ?? Math.floor(Math.random() * 1e9);
  const desc = describeWorld(seed, params.get('style'));
  console.log(
    `[aquarium] seed ${seed}, water "${desc.water.name}", tier ${tier}`,
  );

  const renderer = new Renderer(gpu, quality);
  const waveRng = desc.rng.fork('waves');
  const waves = makeWaves(waveRng);
  const wavePhase = waveRng.range(0, 100);
  const caustics = new Caustics(device, quality.causticsSize, waves, wavePhase);
  const shadow = new SunShadow(
    device,
    quality.shadowSize,
    quality.tierIndex >= 2 ? 45 : 35,
  );
  renderer.shadowMap = (params.get('disable') ?? '').includes('shadows')
    ? null
    : shadow.texture;
  const detail = createDetailTexture(device, desc.rng.fork('detail').nextU32());
  const terrain = await generateTerrain(device, desc.terrain);
  renderer.setTextures({
    caustics: caustics.texture,
    shadow: shadow.texture,
    detail,
    terrain: terrain.texture,
    terrainMask: terrain.maskTexture,
  });
  // Everything that must line up with the drawn seabed needs to know how
  // coarse the drawn mesh is.
  terrain.cpu.meshGrid = quality.terrainGrid;
  const nav = buildNavVolume(desc, terrain.cpu);
  const gen = createGenContext(desc, terrain.cpu, nav, quality);
  nav.o.obstacles = gen.obstacles;
  // Rocks first: other content sits on top of them.
  const rocks = await createRocks(renderer, gen);
  // Coral next: critters settle on its heads.
  const coral = await createCoral(renderer, gen);
  const [critters, plants] = await Promise.all([
    createCritters(renderer, gen),
    createPlants(renderer, gen),
  ]);
  // Fish need the anemones and obstacles placed above.
  const fish = await createFish(renderer, gen);
  const [particles, jellyfish] = await Promise.all([
    createParticles(renderer, gen),
    createJellyfish(renderer, gen),
  ]);
  renderer.setTextures({
    contact: createContactMap(
      device,
      renderer.footprints,
      desc.terrain.worldSize,
      quality.tierIndex >= 2 ? 4096 : 2048,
    ),
  });
  const content = [
    rocks,
    coral,
    critters,
    ...plants,
    fish,
    jellyfish,
    particles,
  ];
  const spots = cameraSpots(
    desc,
    terrain.cpu,
    nav,
    gen.clusters,
    gen.kelpForests,
    gen.tallProps,
    gen.landmarks,
  );

  const targetsFormats = {
    color: 'rgba16float',
    velocity: 'rg16float',
    depth: 'depth32float',
  } as const;
  const bloom = new Bloom(device);
  const [terrainRenderer, background, present, volumetrics, taa] =
    await Promise.all([
      createTerrainRenderer(
        device,
        renderer.globals.layout,
        targetsFormats,
        quality.terrainGrid,
        desc.terrain.worldSize,
        (x, z) => terrain.cpu.heightAt(x, z),
        params.get('flat') === '1',
      ),
      createBackground(device, renderer.globals.layout),
      createPresent(device, renderer.globals.layout, gpu.format),
      createVolumetrics(renderer, quality),
      createTaa(device),
      bloom.init(),
    ]);
  // ?terrain=voxel meshes the seabed from a 3D density field instead of the
  // height map, so it can undercut and be tunnelled through.
  const voxel =
    params.get('terrain') === 'voxel'
      ? await (async () => {
          const t0 = performance.now();
          const mesh = await buildVoxelTerrain(
            device,
            terrain.texture,
            terrain.cpu,
            {
              worldSize: desc.terrain.worldSize,
              cellSize: numParam('cell') ?? 0.75,
              minY: desc.terrain.floorDepth - 40,
              maxY: desc.surfaceY - 3,
              seed: desc.seed,
              relief: numParam('relief') ?? 1,
              debugStats: params.get('voxelstats') === '1',
            },
          );
          console.log(
            `[voxel] ${(mesh.indexCount / 3e3).toFixed(0)}k triangles, ` +
              `${mesh.chunks.filter(c => c.count).length} chunks, ` +
              `${(performance.now() - t0).toFixed(0)} ms`,
          );
          return createVoxelRenderer(
            device,
            renderer.globals.layout,
            targetsFormats,
            mesh,
            params.get('flat') === '1',
          );
        })()
      : null;
  const ground = voxel ?? terrainRenderer;
  renderer.systems.push(
    caustics,
    {
      name: 'terrain',
      update: ctx => ground.update(ctx.view),
      drawOpaque: p => ground.draw(p),
      drawShadow: p => ground.drawShadow(p),
    },
    // Alpha-tested kinds (fish fins, fan lattices) draw last: a pipeline that
    // can discard makes tile-based GPUs shade every fragment drawn before it
    // in the pass, defeating hidden-surface removal for the dense opaque props.
    ...content.filter(s => !ALPHA_TESTED.has(s.name)),
    background,
    ...content.filter(s => ALPHA_TESTED.has(s.name)),
    await createSsao(renderer),
    volumetrics,
  );
  // ?disable=ssao,volumetrics,coral,... drops systems, for profiling.
  const disabled = new Set(
    (params.get('disable') ?? '').split(',').filter(Boolean),
  );
  renderer.systems = renderer.systems.filter(s => !disabled.has(s.name));
  const dof =
    quality.dof && !disabled.has('dof') ? await createDof(device) : null;
  const autoFocus = new AutoFocus(device);
  let focusSampled = false;
  if (dof) {
    renderer.systems.push({
      name: 'autofocus',
      afterOpaque: ctx => {
        focusSampled = autoFocus.sample(ctx.encoder, ctx.targets.depth);
      },
    });
  }
  renderer.post.push(taa);
  if (dof) {
    renderer.post.push(dof);
  }
  renderer.post.push({
    name: 'bloom',
    resize: t => bloom.resize(t),
    run: (ctx, input) => {
      bloom.run(ctx, input);
      return input;
    },
  });
  renderer.post = renderer.post.filter(p => !disabled.has(p.name));
  present.setGrade({
    ...desc.water.grade,
    grain: quality.grain ? desc.water.grade.grain : 0,
  });
  renderer.present = (ctx, input, view) =>
    present.run(ctx, input, bloom.result, view);

  // Camera and controls.
  const input = new Input(canvas);
  const camera = new SwimCamera();
  const tour = new AttractTour(spots.tour);
  // The auto camera follows creatures; the spline tour covers the moments
  // before it has found one.
  const follow = new CreatureCam(nav, fish, jellyfish, desc.rng.fork('follow'));
  let following = false;
  // ?pos=x,y,z&look=yaw,pitch puts the camera exactly somewhere, so a spot
  // reported from one machine can be opened on another.
  const posParam = params
    .get('pos')
    ?.split(',')
    .map(Number)
    .filter(n => Number.isFinite(n));
  const lookParam = params
    .get('look')
    ?.split(',')
    .map(Number)
    .filter(n => Number.isFinite(n));
  const fixedCamera =
    params.get('camera') ?? (posParam?.length === 3 ? 'pos' : null);
  const setCamera = (
    name:
      | string
      | {pos: [number, number, number]; target: [number, number, number]},
  ) => {
    const spot = typeof name === 'string' ? spots.presets[name] : name;
    if (!spot) {
      reportError(
        `[aquarium] unknown camera "${String(name)}"; have ${Object.keys(spots.presets).join(', ')}`,
      );
      return;
    }
    camera.setPose(spot.pos, spot.target);
    attractActive = false;
    taa.reset();
  };
  let attractActive = !fixedCamera;
  let lastAutoPose: CameraPose = {pos: [0, 0, 0], yaw: 0, pitch: 0, roll: 0};
  if (posParam?.length === 3) {
    const [yawDeg, pitchDeg] = lookParam?.length === 2 ? lookParam : [0, 0];
    const yaw = (yawDeg * Math.PI) / 180;
    const pitch = (pitchDeg * Math.PI) / 180;
    const f = forwardFromAngles(yaw, pitch);
    setCamera({
      pos: [posParam[0], posParam[1], posParam[2]],
      target: [
        posParam[0] + f[0] * 20,
        posParam[1] + f[1] * 20,
        posParam[2] + f[2] * 20,
      ],
    });
  } else if (fixedCamera) {
    setCamera(fixedCamera);
  } else {
    camera.setPose(spots.tour[0].pos, spots.tour[0].target);
    tour.begin(camera.pose);
    follow.begin(camera.pose);
  }
  // The cinematic tour resumes after this many seconds without input.
  const idleToAttract = 5;

  const clock = new Clock(numParam('time') ?? 0, params.get('paused') === '1');
  const dynres = new DynamicResolution(quality);
  // ?scale=0.8 fixes the render scale (and turns dynamic resolution off).
  const fixedScale = numParam('scale');
  if (fixedScale !== null) {
    dynres.scale = Math.min(1, Math.max(0.25, fixedScale));
  }

  // Canvas sizing.
  let canvasW = 1;
  let canvasH = 1;
  // Render in CSS pixels (devicePixelRatio deliberately ignored: on high-DPI
  // screens it multiplies the pixel count for detail TAA and the water blur
  // away anyway), capped by the tier's pixel budget.
  const resize = (cssW: number, cssH: number) => {
    let w = cssW;
    let h = cssH;
    const pixels = w * h;
    if (pixels > quality.maxCanvasPixels) {
      const s = Math.sqrt(quality.maxCanvasPixels / pixels);
      w *= s;
      h *= s;
    }
    canvasW = Math.max(1, Math.round(w));
    canvasH = Math.max(1, Math.round(h));
  };
  resize(canvas.clientWidth, canvas.clientHeight);
  new ResizeObserver(entries => {
    for (const e of entries) {
      resize(e.contentRect.width, e.contentRect.height);
    }
  }).observe(canvas);

  window.__aquarium.setCamera = setCamera;
  window.__aquarium.setTime = (t: number) => clock.setTime(t);
  window.__aquarium.step = (seconds: number, frames: number) =>
    clock.step(seconds, frames);
  window.__aquarium.pause = (p: boolean) => (clock.paused = p);
  // Benchmark: renders the current view `frames` times back-to-back (no
  // vsync), waiting for the GPU after each; resolves to ms per frame.
  window.__aquarium.bench = async (frames: number) => {
    // Skip presenting to the canvas: that would pace the loop to the display.
    const present = renderer.present;
    renderer.present = null;
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      renderer.render(clock.time, 1 / 60);
      await device.queue.onSubmittedWorkDone();
    }
    const ms = (performance.now() - t0) / frames;
    renderer.present = present;
    return ms;
  };
  window.__aquarium.info = {
    seed,
    tier,
    water: desc.water.name,
    adapter: gpu.info.vendor,
  };
  window.__aquarium.presets = Object.keys(spots.presets);
  window.__aquarium.spots = spots;
  window.__aquarium.kelp = gen.kelpForests;
  window.__aquarium.tallProps = gen.tallProps;
  window.__aquarium.camera = camera;
  window.__aquarium.follow = follow;
  window.__aquarium.jellyfish = jellyfish;
  window.__aquarium.obstacles = gen.obstacles;
  window.__aquarium.clearings = gen.clearings;
  window.__aquarium.clusters = gen.clusters;
  window.__aquarium.nav = nav;
  window.__aquarium.clusters = gen.clusters;
  window.__aquarium.terrain = terrain.cpu;
  window.__aquarium.desc = desc;
  window.__aquarium.anemones = gen.anemones;

  const view = mat4.create();
  const proj = mat4.create();
  const viewProj = mat4.create();
  const prevViewProj = mat4.create();
  const jitteredProj = mat4.create();
  const jitteredViewProj = mat4.create();
  let firstFrame = true;
  let lastFrameStart = performance.now();
  let fpsAvg = 60;
  let frameIndex = 0;
  let focus = 8;
  let gpuMs = 0;
  let cpuMs = 0;
  let gpuPending = false;
  const profile = params.has('profile');

  hud.textContent =
    `seed ${seed} · ${desc.water.name} · ${tier}\n` +
    (matchMedia('(pointer: coarse)').matches
      ? 'left: swim · right: look · two fingers: up/down'
      : 'click to look · WASD swim · space/C up/down · shift fast');
  if (params.get('hud') === '0') {
    hud.hidden = true;
  }
  setTimeout(() => hud.classList.add('hidden'), 8000);

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const frameMs = now - lastFrameStart;
    lastFrameStart = now;
    if (!firstFrame && frameMs > 0) {
      fpsAvg = fpsAvg * 0.95 + (1000 / frameMs) * 0.05;
      if (fixedScale === null) {
        dynres.update(frameMs);
      }
    }
    clock.tick(now);
    const dt = clock.dt;
    const realDt = Math.min(frameMs / 1000, 0.1) || 1 / 60;

    const inputState = input.read(realDt);
    let pose: CameraPose;
    if (attractActive) {
      const step = clock.paused ? dt : realDt;
      if (input.idleTime < 0.05) {
        // Hand control back from wherever the auto camera is.
        attractActive = false;
        camera.pose = {...lastAutoPose, roll: 0};
        camera.vel = [0, 0, 0];
        pose = camera.renderPose();
      } else {
        // Keep both running so the hand-over from the tour to following is
        // just the follow camera starting where the tour currently is.
        const tourPose = tour.update(following ? 0 : step);
        if (!following) {
          follow.syncPose(tourPose);
        }
        const followPose = follow.update(step);
        following = following || follow.ready;
        pose = following ? followPose : tourPose;
        lastAutoPose = pose;
        window.__aquarium.autoPose = pose;
      }
    } else {
      camera.update(inputState, clock.paused && dt === 0 ? 0 : realDt, nav);
      pose = camera.renderPose();
      if (!fixedCamera && input.idleTime > idleToAttract && !clock.paused) {
        attractActive = true;
        tour.begin(camera.pose);
        follow.begin(camera.pose);
        following = false;
      }
    }

    const scale = dynres.scale;
    renderer.resize(canvasW * scale, canvasH * scale);
    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW;
      canvas.height = canvasH;
    }

    const t = renderer.targets;
    viewMatrix(pose, view);
    mat4.perspectiveReversedZ(
      (68 * Math.PI) / 180,
      t.width / t.height,
      0.05,
      proj,
    );
    prevViewProj.set(firstFrame ? mat4.multiply(proj, view) : viewProj);
    mat4.multiply(proj, view, viewProj);
    const jx = quality.taa ? halton((frameIndex % 8) + 1, 2) - 0.5 : 0;
    const jy = quality.taa ? halton((frameIndex % 8) + 1, 3) - 0.5 : 0;
    jitteredProj.set(proj);
    jitteredProj[8] += (jx * 2) / t.width;
    jitteredProj[9] += (jy * 2) / t.height;
    mat4.multiply(jitteredProj, view, jitteredViewProj);
    const forward = forwardFromAngles(pose.yaw, pose.pitch);
    shadow.update(pose.pos, forward, desc.sunDir, desc.surfaceY);
    if (dof) {
      // Focus on whatever the camera is looking at, eased like a camera operator would.
      const target =
        autoFocus.measured ?? focusDistance(pose.pos, forward, gen);
      const ease = 1 - Math.exp(-(clock.paused ? 0.2 : realDt) * 3);
      focus += (target - focus) * ease;
      dof.setFocus(focus);
    }

    const g = renderer.globals.data;
    g.set('view', view);
    g.set('proj', jitteredProj);
    g.set('viewProj', jitteredViewProj);
    g.set('invViewProj', mat4.invert(viewProj));
    g.set('viewProjNoJitter', viewProj);
    g.set('prevViewProjNoJitter', prevViewProj);
    g.set('shadowViewProj', shadow.viewProj);
    renderer.cullView.camPos.set(pose.pos);
    renderer.cullView.viewProj.set(viewProj);
    renderer.cullView.shadowViewProj.set(shadow.viewProj);
    renderer.cullView.focalPx = (canvasH / 2) * proj[5];
    g.set('camPos', pose.pos);
    g.set('time', clock.time);
    g.set('sunDir', desc.sunDir);
    g.set('frameIndex', frameIndex);
    g.set('sunColor', desc.water.sunColor);
    g.set('exposure', desc.water.exposure * (numParam('exposure') ?? 1));
    g.set('absorption', desc.water.absorption);
    g.set('scattering', desc.water.scattering);
    g.set(
      'ambientColor',
      desc.water.ambient.map(v => v * (numParam('amb') ?? 1)),
    );
    g.set('surfaceY', desc.surfaceY);
    g.set('resolution', [t.width, t.height]);
    g.set('jitter', [jx, jy]);
    g.set('caustics', [
      WAVE_TILE,
      0.95,
      28,
      // Mip bias so a smaller caustics texture stays as sharp per metre.
      Math.log2(512 / quality.causticsSize),
    ]);
    g.set('terrain', [desc.terrain.worldSize, desc.terrain.size, 0, 0]);
    g.set('shadow', [shadow.texelWorld, shadow.size, 0, 0]);
    g.set('misc', [dt, quality.tierIndex, numParam('fog') ?? 0.6, wavePhase]);
    g.set('waves', waves);

    fish.setCamera(pose.pos, forward);
    const cpuStart = performance.now();
    renderer.render(clock.time, dt);
    // Benchmark load (window.__aquarium.extraRenders): render the frame again
    // without presenting, so the GPU cost shows up as a lower frame rate.
    const extra = (window.__aquarium.extraRenders as number | undefined) ?? 0;
    if (extra > 0) {
      const present = renderer.present;
      renderer.present = null;
      for (let i = 0; i < extra; i++) {
        renderer.render(clock.time, 0);
      }
      renderer.present = present;
    }
    if (focusSampled) {
      focusSampled = false;
      autoFocus.read();
    }
    gpuProfiler?.endFrame();
    const submitted = performance.now();
    if (!gpuPending) {
      // Submit-to-done latency approximates GPU frame cost without timestamp queries.
      gpuPending = true;
      void device.queue.onSubmittedWorkDone().then(() => {
        gpuMs = gpuMs * 0.9 + (performance.now() - submitted) * 0.1;
        gpuPending = false;
      });
    }
    cpuMs = cpuMs * 0.9 + (submitted - cpuStart) * 0.1;
    frameIndex++;
    window.__aquarium.frame++;
    window.__aquarium.fps = fpsAvg;
    window.__aquarium.gpuMs = gpuMs;
    window.__aquarium.cpuMs = cpuMs;
    // ?where=1 keeps the camera's position on screen, so a spot worth
    // reporting can be read straight off a screenshot.
    if (params.get('where') === '1' && frameIndex % 10 === 0) {
      hud.classList.remove('hidden');
      hud.hidden = false;
      const p = pose.pos;
      hud.textContent =
        `seed ${seed} · ${tier}\n` +
        `pos ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${p[2].toFixed(1)} · ` +
        `yaw ${((pose.yaw * 180) / Math.PI).toFixed(0)} pitch ${((pose.pitch * 180) / Math.PI).toFixed(0)} · ` +
        `floor ${nav.floorAt(p[0], p[2]).toFixed(1)}\n` +
        `terrain ${ground.stats.chunks} chunks · ` +
        `${(ground.stats.triangles / 1000).toFixed(0)}k triangles\n` +
        // The query string that reproduces this exact view elsewhere.
        `?seed=${seed}&quality=${tier}&pos=${p.map(v => v.toFixed(1)).join(',')}` +
        `&look=${((pose.yaw * 180) / Math.PI).toFixed(0)},${((pose.pitch * 180) / Math.PI).toFixed(0)}`;
    }
    if (profile && frameIndex % 15 === 0) {
      hud.classList.remove('hidden');
      hud.hidden = false;
      hud.textContent =
        `${fpsAvg.toFixed(0)} fps · gpu ~${gpuMs.toFixed(1)} ms · cpu ${cpuMs.toFixed(1)} ms · ${renderer.targets.width}x${renderer.targets.height} (${(dynres.scale * 100).toFixed(0)}%) · ${tier}` +
        (gpuProfiler ? `\n${gpuProfiler.summary()}` : '');
    }

    if (firstFrame) {
      firstFrame = false;
      loading.style.opacity = '0';
      setTimeout(() => (loading.style.display = 'none'), 1200);
      if (params.get('hud') === '0') {
        loading.style.display = 'none';
      }
      void device.queue.onSubmittedWorkDone().then(markReady);
    }
  };
  requestAnimationFrame(frame);
}

main().catch(e => {
  if (e instanceof WebGPUUnavailableError) {
    showUnsupported(e.reason);
    // Still recorded for tests, but without the red debug overlay.
    console.warn(e.message);
    window.__aquarium.errors.push(e.message);
    return;
  }
  reportError(`[fatal] ${e?.stack ?? e}`);
});
