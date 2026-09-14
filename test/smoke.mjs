// Smoke test: loads the aquarium in headless Chrome, renders frames, and fails
// on any WebGPU/validation/shader error or a blank frame.
//
//   node test/smoke.mjs [--min-stddev=N]
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {launch, openAquarium, waitFrames, getErrors, capture} from './harness.mjs';

const minStddevArg = process.argv.find(a => a.startsWith('--min-stddev='));
const minStddev = minStddevArg ? Number(minStddevArg.split('=')[1]) : 4;
const outDir = path.resolve(import.meta.dirname, '../screenshots/smoke');
await fs.mkdir(outDir, {recursive: true});

const configs = [
  {name: 'desktop', params: {seed: '1', camera: 'reef', time: '10'}},
  {
    name: 'mobile',
    params: {seed: '2', camera: 'reef', time: '10', quality: 'mobile'},
    viewport: {width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true},
  },
];

const ctx = await launch();
let failed = false;
try {
  // Every seed must generate without errors (catches degenerate random layouts).
  for (let seed = 3; seed <= 14; seed++) {
    const {page} = await openAquarium(ctx, {seed: String(seed)}, {width: 320, height: 180});
    await waitFrames(page, 3);
    const errors = await getErrors(page);
    if (errors.length) {
      console.error(`[smoke:seed${seed}] FAIL: ${errors[0]}`);
      failed = true;
    }
    await page.close();
  }
  for (const cfg of configs) {
    const {page} = await openAquarium(ctx, cfg.params, cfg.viewport);
    await waitFrames(page, 30);
    const errors = await getErrors(page);
    const {stats} = await capture(page, path.join(outDir, `${cfg.name}.png`));
    const info = await page.evaluate(() => window.__aquarium.info ?? null);
    console.log(`[smoke:${cfg.name}] frame stats`, stats, info ?? '');
    if (errors.length) {
      console.error(`[smoke:${cfg.name}] FAIL: ${errors.length} error(s)`);
      failed = true;
    }
    if (stats.stddev < minStddev) {
      console.error(`[smoke:${cfg.name}] FAIL: frame looks blank (stddev ${stats.stddev.toFixed(2)})`);
      failed = true;
    }
    await page.close();
  }
} finally {
  await ctx.close();
}
console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED');
process.exit(failed ? 1 : 0);
