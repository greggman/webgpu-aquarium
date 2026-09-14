// Builds src/ into dist/ with esbuild.
//
//   node scripts/build.mjs            one-off production build
//   node scripts/build.mjs --watch    rebuild on change
//   node scripts/build.mjs --watch --serve   rebuild on change and serve dist/
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {startServer} from './serve.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

const copyStatic = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(async result => {
      if (result.errors.length) {
        return;
      }
      await fs.copyFile(
        path.join(root, 'index.html'),
        path.join(dist, 'index.html'),
      );
      console.log(`[build] ${new Date().toLocaleTimeString()} done`);
    });
  },
};

await fs.mkdir(dist, {recursive: true});

const options = {
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: path.join(dist, 'main.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: !watch,
  loader: {'.wgsl': 'text'},
  logLevel: 'warning',
  plugins: [copyStatic],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  if (serve) {
    startServer(dist);
  }
} else {
  await esbuild.build(options);
}
