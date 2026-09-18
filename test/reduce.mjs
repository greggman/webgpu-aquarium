// Reduces a shader against real Safari: for each candidate WGSL file, loads
// the app with that file compiled in place of one shader (?wgsl=label=url),
// renders a fixed number of frames, and counts NaN texels in the scene
// buffer after each. One Safari session serves all candidates, so a
// candidate costs a few seconds. Written to reduce bugs/webkit-discard.md;
// the shape of that fault (a threshold in control flow) is why every
// candidate is a whole shader rather than a construct built up from nothing.
//
// Needs "safaridriver --enable" once. The app must be built (npm run build).
//
// Usage: node test/reduce.mjs [--frames=30] [--label=fish:render-shader]
//          [--params='only=fish&fishcut=both&seed=221315123&camera=reef&paused=1&time=0&scale=1&hud=0']
//          a.wgsl b.wgsl ...
//
// To get the shader as compiled, to start editing from:
//   __aquarium.shaders['fish:render-shader']   (in the console)

import {spawn} from 'node:child_process';
import path from 'node:path';
import express from 'express';

const dist = path.resolve(import.meta.dirname, '../dist');
const PORT = 4457;
const base = `http://localhost:${PORT}`;

const args = process.argv.slice(2);
const opt = Object.fromEntries(
  args
    .filter(a => a.startsWith('--'))
    .map(a => {
      const i = a.indexOf('=');
      return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
    }),
);
const files = args.filter(a => !a.startsWith('--')).map(f => path.resolve(f));
const frames = Number(opt.frames ?? 30);
const label = opt.label ?? 'fish:render-shader';
const params =
  opt.params ??
  'only=fish&fishcut=both&seed=221315123&camera=reef&paused=1&time=0&scale=1&hud=0';
if (!files.length) {
  console.error('usage: node test/reduce.mjs [--frames=N] a.wgsl b.wgsl ...');
  process.exit(1);
}

async function send(method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (json.value?.error) {
    throw new Error(`${json.value.error}: ${json.value.message}`);
  }
  return json.value;
}
const asyncScript = body => `
  const done = arguments[arguments.length - 1];
  (async () => { ${body} })().then(
    v => done({ok: v}),
    e => done({err: String(e)}),
  );`;

// Serve dist, plus each candidate's directory under /wgsl/<n>/.
const app = express();
const dirs = [...new Set(files.map(f => path.dirname(f)))];
dirs.forEach((d, n) =>
  app.use(`/wgsl/${n}`, express.static(d, {etag: false, lastModified: false})),
);
app.use(express.static(dist, {etag: false, lastModified: false}));
const server = await new Promise(r => {
  const s = app.listen(0, () => r(s));
});
const port = server.address().port;
const urlFor = f =>
  `/wgsl/${dirs.indexOf(path.dirname(f))}/${path.basename(f)}`;

const driver = spawn('safaridriver', ['-p', String(PORT)], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stop = () => {
  driver.kill();
  server.close();
};
process.on('exit', stop);
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`${base}/status`);
    break;
  } catch {
    await new Promise(r => setTimeout(r, 250));
  }
}
let session;
try {
  session = await send('POST', '/session', {
    capabilities: {alwaysMatch: {browserName: 'safari'}},
  });
} catch (e) {
  console.error(`Could not start Safari: ${e.message}`);
  console.error('Run "safaridriver --enable" once, then try again.');
  stop();
  process.exit(1);
}
const s = `/session/${session.sessionId}`;
const results = [];
try {
  // The canvas takes the window's size, and the count depends on it.
  await send('POST', `${s}/window/rect`, {x: 0, y: 0, width: 900, height: 700});
  await send('POST', `${s}/timeouts`, {script: 60000});
  console.log(
    `[safari ${session.capabilities?.browserVersion ?? ''}] ${params}`,
  );
  for (const file of files) {
    const t0 = Date.now();
    const override = encodeURIComponent(`${label}=${urlFor(file)}`);
    await send('POST', `${s}/url`, {
      url: `http://localhost:${port}/index.html?${params}&wgsl=${override}`,
    });
    let built = false;
    let errors = [];
    for (let i = 0; i < 240; i++) {
      const st = await send('POST', `${s}/execute/sync`, {
        script: `return {pump: typeof window.__aquarium?.pump === 'function',
                         errors: window.__aquarium?.errors ?? []};`,
        args: [],
      });
      errors = st.errors;
      if (errors.length || st.pump) {
        built = st.pump;
        break;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    const name = path.basename(file);
    if (errors.length) {
      console.log(`${name}: ERROR ${errors.join(' | ').slice(0, 600)}`);
      results.push(`${name}=ERROR`);
      continue;
    }
    if (!built) {
      console.log(`${name}: world did not build`);
      results.push(`${name}=NOBUILD`);
      continue;
    }
    let total = 0;
    let bad = 0;
    const per = [];
    let err = null;
    for (let f = 0; f < frames; f++) {
      const r = await send('POST', `${s}/execute/async`, {
        script: asyncScript(`
          await window.__aquarium.pump(1);
          const r = await window.__aquarium.scanHdr();
          return {nan: r.nan, inf: r.inf, errors: window.__aquarium.errors};`),
        args: [],
      });
      if (r.err) {
        err = r.err;
        break;
      }
      if (r.ok.errors.length) {
        err = r.ok.errors.join(' | ');
        break;
      }
      const n = r.ok.nan + r.ok.inf;
      per.push(n);
      total += n;
      if (n) {
        bad++;
      }
    }
    if (err) {
      console.log(`${name}: ERROR ${err.slice(0, 600)}`);
      results.push(`${name}=ERROR`);
      continue;
    }
    const verdict = total ? 'FAIL' : 'clean';
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `${name}: ${verdict} ${total} bad texels in ${bad}/${per.length} frames [${per.join(',')}] ${secs}s`,
    );
    results.push(`${name}=${verdict}:${total}`);
  }
} finally {
  await send('DELETE', s).catch(() => {});
  stop();
}
console.log(`SUMMARY ${results.join('  ')}`);
