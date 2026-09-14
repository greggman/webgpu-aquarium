// Rough performance check: renders a few seeds at 1920x1080 and reports the
// smoothed GPU/CPU frame times the app measures itself.
//
//   node test/perf.mjs [--seeds=1,2,3,4] [--cameras=reef,wide] [--quality=high]
//
// Note: the GPU figure is submit-to-done latency. When a frame costs more than
// the display interval, work queues up and it jumps to ~80 ms: treat anything
// far above ~17 ms as "over budget", not as the literal frame cost.
import {launch, openAquarium, waitFrames} from './harness.mjs';

const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const seeds = arg('seeds', '1,2,3,4').split(',').map(Number);
const cameras = arg('cameras', arg('camera', 'reef')).split(',');
const quality = arg('quality', '');

const ctx = await launch();
try {
  for (const seed of seeds) {
    for (const camera of cameras) {
      const params = {seed: String(seed), camera};
      if (quality) {
        params.quality = quality;
      }
      const {page} = await openAquarium(ctx, params, {
        width: 1920,
        height: 1080,
      });
      await waitFrames(page, 240);
      const r = await page.evaluate(() => ({
        gpuMs: window.__aquarium.gpuMs,
        cpuMs: window.__aquarium.cpuMs,
        fps: window.__aquarium.fps,
        tier: window.__aquarium.info.tier,
      }));
      console.log(
        `[perf] seed ${seed} ${camera} ${r.tier}: gpu ~${r.gpuMs.toFixed(1)} ms, cpu ${r.cpuMs.toFixed(1)} ms, ${r.fps.toFixed(0)} fps`,
      );
      await page.close();
    }
  }
} finally {
  await ctx.close();
}
