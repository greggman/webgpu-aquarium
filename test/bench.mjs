// GPU cost benchmark that isn't capped by vsync: renders each frame several
// extra times (without presenting) and derives ms per render from the frame
// rate. Disabling systems one by one shows what each costs.
//
//   node test/bench.mjs [seed] [camera] [disable-list] [WxH] [extra-renders]
//   node test/bench.mjs 202 overhead ",coral,terrain,volumetrics"
//
// Each comma-separated entry is one run; use | to disable several at once.
import {launch, openAquarium, waitFrames} from './harness.mjs';
const seed = process.argv[2] ?? '202';
const camera = process.argv[3] ?? 'overhead';
const runs = (
  process.argv[4] ??
  ',coral,rocks,critters,plants|fans,terrain,fish,jellyfish|particles,shadows,ssao,volumetrics,dof,taa'
).split(',');
const size = (process.argv[5] ?? '1920x1080').split('x').map(Number);
const extra = Number(process.argv[6] ?? 5);
const ctx = await launch();
for (const d of runs) {
  const dis = d.replaceAll('|', ',');
  const params = {seed, camera, paused: '1', hud: '0'};
  if (dis) params.disable = dis;
  const {page} = await openAquarium(ctx, params, {
    width: size[0],
    height: size[1],
  });
  await page.evaluate(() => window.__aquarium.step(4, 60));
  await waitFrames(page, 20);
  const ms = await page.evaluate(async extra => {
    window.__aquarium.extraRenders = extra;
    // Warm up, then time rAF intervals.
    for (let i = 0; i < 20; i++)
      await new Promise(r => requestAnimationFrame(r));
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 4000) {
      await new Promise(r => requestAnimationFrame(r));
      n++;
    }
    window.__aquarium.extraRenders = 0;
    return (performance.now() - t0) / n / (extra + 1);
  }, extra);
  console.log(
    `[bench] ${size.join('x')} seed ${seed} ${camera} disable=${dis || '-'}: ~${ms.toFixed(2)} ms per render`,
  );
  await page.close();
}
await ctx.close();
