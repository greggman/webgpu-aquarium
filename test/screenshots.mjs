// Captures screenshots for visual review (used by the aaa-judge agent).
//
//   node test/screenshots.mjs [--seeds=1,2,3] [--cameras=reef,kelp,overhead,wide]
//                             [--tier=high|mobile|both] [--time=20] [--seq=3]
//                             [--size=1920x1080] [--out=dir]
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {launch, openAquarium, waitFrames, getErrors, capture} from './harness.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v = 'true'] = a.slice(2).split('=');
      return [k, v];
    }),
);
if (args.help) {
  console.log(
    'node test/screenshots.mjs [--seeds=1,2,3] [--cameras=reef,kelp,overhead,wide] ' +
      '[--tier=high|mobile|both] [--time=20] [--seq=3] [--size=1920x1080] [--out=dir]',
  );
  process.exit(0);
}

const seeds = (args.seeds ?? '1,2,3').split(',');
const cameras = (args.cameras ?? 'reef,kelp,overhead,wide').split(',');
const tier = args.tier ?? 'high';
const tiers = tier === 'both' ? ['high', 'mobile'] : [tier];
const time = args.time ?? '20';
const seq = Number(args.seq ?? 3);
const [w, h] = (args.size ?? '1920x1080').split('x').map(Number);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(args.out ?? path.join(import.meta.dirname, '../screenshots', runId));
await fs.mkdir(outDir, {recursive: true});

const ctx = await launch();
let errorCount = 0;
try {
  for (const t of tiers) {
    const viewport =
      t === 'mobile'
        ? {width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true}
        : {width: w, height: h};
    for (const seed of seeds) {
      const {page} = await openAquarium(ctx, {seed, quality: t, time, camera: cameras[0], paused: '1'}, viewport);
      for (const cam of cameras) {
        await page.evaluate(
          (cam, time) => {
            window.__aquarium.setCamera(cam);
            window.__aquarium.setTime(Number(time));
          },
          cam,
          time,
        );
        // Let temporal effects (TAA, volumetric history) converge on the still frame.
        await page.evaluate(() => window.__aquarium.step(0, 40));
        await waitFrames(page, 2);
        const base = `${t}-seed${seed}-${cam}`;
        await capture(page, path.join(outDir, `${base}.png`));
        for (let i = 1; i <= seq; i++) {
          // Advance simulated time by 1/6 s per frame of the sequence.
          await page.evaluate(() => window.__aquarium.step(1 / 6, 4));
          await waitFrames(page, 2);
          await capture(page, path.join(outDir, `${base}-seq-${i}.png`));
        }
      }
      const errors = await getErrors(page);
      if (errors.length) {
        errorCount += errors.length;
        console.error(`[shots] seed ${seed} ${t}: ${errors.length} error(s)\n${errors.join('\n')}`);
      }
      await page.close();
    }
  }
} finally {
  await ctx.close();
}
console.log(`[shots] wrote ${outDir}`);
process.exit(errorCount ? 1 : 0);
