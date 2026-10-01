// Builds src/ into dist/ with esbuild.
//
//   node scripts/build.mjs            one-off production build (minified JS
//                                     and WGSL)
//   node scripts/build.mjs --watch    rebuild on change
//   node scripts/build.mjs --watch --serve   rebuild on change and serve dist/
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import {startServer} from './serve.mjs';
import {wgslMinifyPlugin} from './wgsl-minify.mjs';

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
      for (const file of ['index.html', 'preview.jpg']) {
        await fs.copyFile(path.join(root, file), path.join(dist, file));
      }
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
  // Production also strips comments and whitespace from WGSL.
  plugins: watch ? [copyStatic] : [wgslMinifyPlugin, copyStatic],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  if (serve) {
    startServer(dist);
  }
} else {
  await esbuild.build(options);
  await reportSize();
}

// What a visitor downloads: preview.jpg is only for link previews, and the
// source map only loads with devtools open.
async function reportSize() {
  const kb = n => `${(n / 1024).toFixed(1).padStart(7)} KB`;
  let raw = 0;
  let gz = 0;
  for (const file of ['index.html', 'main.js']) {
    const data = await fs.readFile(path.join(dist, file));
    const zipped = zlib.gzipSync(data, {level: 9}).length;
    raw += data.length;
    gz += zipped;
    console.log(
      `  ${file.padEnd(10)} ${kb(data.length)} ${kb(zipped)} gzipped`,
    );
  }
  console.log(`  ${'total'.padEnd(10)} ${kb(raw)} ${kb(gz)} gzipped`);
}
