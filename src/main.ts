import {initGPU, markReady, reportError} from './gpu/device.ts';
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
import {SunShadow} from './render/shadows.ts';
import {createVolumetrics} from './render/volumetrics.ts';
import {createSsao} from './render/ssao.ts';
import {createDof} from './render/post/dof.ts';
import {focusDistance} from './player/focus.ts';
import {createTaa, halton} from './render/post/taa.ts';
import {Bloom} from './render/post/bloom.ts';
import {forwardFromAngles} from './player/camera.ts';
import {createGenContext} from './world/layout.ts';
import {createRocks} from './gen/kinds/rocks.ts';
import {createCoral} from './gen/kinds/coral.ts';
import {createCritters} from './gen/kinds/critters.ts';
import {createPlants} from './gen/kinds/plants.ts';
import {createFish} from './sim/fish.ts';
import {createJellyfish} from './sim/jellyfish.ts';
import {createParticles} from './render/particles.ts';

const params = new URLSearchParams(location.search);
const numParam = (name: string) =>
  params.has(name) ? Number(params.get(name)) : null;

async function main() {
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const hud = document.getElementById('hud')!;
  const loading = document.getElementById('loading')!;

  const gpu = await initGPU(canvas);
  const {device} = gpu;
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
  renderer.shadowMap = shadow.texture;
  const detail = createDetailTexture(device, desc.rng.fork('detail').nextU32());
  const terrain = await generateTerrain(device, desc.terrain);
  renderer.setTextures({
    caustics: caustics.texture,
    shadow: shadow.texture,
    detail,
    terrain: terrain.texture,
    terrainMask: terrain.maskTexture,
  });
  const nav = buildNavVolume(desc, terrain.cpu);
  const gen = createGenContext(desc, terrain.cpu, nav, quality);
  nav.o.obstacles = gen.obstacles;
  // Rocks first: other content sits on top of them.
  const rocks = await createRocks(renderer, gen);
  const [coral, critters, plants] = await Promise.all([
    createCoral(renderer, gen),
    createCritters(renderer, gen),
    createPlants(renderer, gen),
  ]);
  // Fish need the anemones and obstacles placed above.
  const fish = await createFish(renderer, gen);
  const [particles, jellyfish] = await Promise.all([
    createParticles(renderer, gen),
    createJellyfish(renderer, gen),
  ]);
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
      ),
      createBackground(device, renderer.globals.layout),
      createPresent(device, renderer.globals.layout, gpu.format),
      createVolumetrics(renderer, quality),
      createTaa(device),
      bloom.init(),
    ]);
  renderer.systems.push(
    caustics,
    {
      name: 'terrain',
      drawOpaque: p => terrainRenderer.draw(p),
      drawShadow: p => terrainRenderer.drawShadow(p),
    },
    ...content,
    background,
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
  const fixedCamera = params.get('camera');
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
  if (fixedCamera) {
    setCamera(fixedCamera);
  } else {
    camera.setPose(spots.tour[0].pos, spots.tour[0].target);
    tour.begin(camera.pose);
  }
  const idleToAttract = 20;

  const clock = new Clock(numParam('time') ?? 0, params.get('paused') === '1');
  const dynres = new DynamicResolution(quality);

  // Canvas sizing.
  let canvasW = 1;
  let canvasH = 1;
  const resize = (cssW: number, cssH: number, dpr: number) => {
    let w = cssW * dpr;
    let h = cssH * dpr;
    const pixels = w * h;
    if (pixels > quality.maxCanvasPixels) {
      const s = Math.sqrt(quality.maxCanvasPixels / pixels);
      w *= s;
      h *= s;
    }
    canvasW = Math.max(1, Math.round(w));
    canvasH = Math.max(1, Math.round(h));
  };
  resize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio);
  new ResizeObserver(entries => {
    for (const e of entries) {
      resize(e.contentRect.width, e.contentRect.height, devicePixelRatio);
    }
  }).observe(canvas);

  window.__aquarium.setCamera = setCamera;
  window.__aquarium.setTime = (t: number) => clock.setTime(t);
  window.__aquarium.step = (seconds: number, frames: number) =>
    clock.step(seconds, frames);
  window.__aquarium.pause = (p: boolean) => (clock.paused = p);
  window.__aquarium.info = {
    seed,
    tier,
    water: desc.water.name,
    adapter: gpu.info.vendor,
  };
  window.__aquarium.presets = Object.keys(spots.presets);
  window.__aquarium.nav = nav;

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
      dynres.update(frameMs);
    }
    clock.tick(now);
    const dt = clock.dt;
    const realDt = Math.min(frameMs / 1000, 0.1) || 1 / 60;

    const inputState = input.read(realDt);
    let pose: CameraPose;
    if (attractActive) {
      if (input.idleTime < 0.05) {
        // Hand control back from wherever the tour is.
        attractActive = false;
        const p = tour.update(0);
        camera.pose = {...p, roll: p.roll};
        camera.vel = [0, 0, 0];
        pose = camera.renderPose();
      } else {
        pose = tour.update(clock.paused ? dt : realDt);
      }
    } else {
      camera.update(inputState, clock.paused && dt === 0 ? 0 : realDt, nav);
      pose = camera.renderPose();
      if (!fixedCamera && input.idleTime > idleToAttract && !clock.paused) {
        attractActive = true;
        tour.begin(camera.pose);
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
      const target = focusDistance(pose.pos, forward, gen);
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
    g.set('caustics', [WAVE_TILE, 0.9, 18, 0]);
    g.set('terrain', [desc.terrain.worldSize, desc.terrain.size, 0, 0]);
    g.set('shadow', [shadow.texelWorld, shadow.size, 0, 0]);
    g.set('misc', [dt, quality.tierIndex, numParam('fog') ?? 0.6, wavePhase]);
    g.set('waves', waves);

    fish.setCamera(pose.pos);
    const cpuStart = performance.now();
    renderer.render(clock.time, dt);
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
    if (profile && frameIndex % 15 === 0) {
      hud.classList.remove('hidden');
      hud.hidden = false;
      hud.textContent = `${fpsAvg.toFixed(0)} fps · gpu ~${gpuMs.toFixed(1)} ms · cpu ${cpuMs.toFixed(1)} ms · ${renderer.targets.width}x${renderer.targets.height} (${(dynres.scale * 100).toFixed(0)}%) · ${tier}`;
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

main().catch(e => reportError(`[fatal] ${e?.stack ?? e}`));
