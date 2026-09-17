// Drives real Safari through safaridriver, which is the only way to run this
// against WebKit's WebGPU: Playwright's WebKit and Firefox builds have no
// navigator.gpu at all. WebDriver is a plain REST API, so this needs no client
// library.
//
// Safari needs "Allow remote automation" turned on once, with:
//
//   safaridriver --enable
//
// Usage: node test/safari.mjs [seconds] [key=value ...]
//   node test/safari.mjs 30 seed=221315123 only=fish
//
// Reports any pixel in the scene buffer that is not finite or is far brighter
// than the scene ever gets, with its position, and saves a screenshot of the
// worst frame.

import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startServer} from '../scripts/serve.mjs';

const dist = path.resolve(import.meta.dirname, '../dist');
const PORT = 4455;
const base = `http://localhost:${PORT}`;

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

/** Runs a promise-returning body in the page and resolves to its value. */
const asyncScript = body => `
  const done = arguments[arguments.length - 1];
  (async () => { ${body} })().then(
    v => done({ok: v}),
    e => done({err: String(e)}),
  );`;

async function main() {
  const args = process.argv.slice(2);
  const seconds = Number(args[0]) > 0 ? Number(args[0]) : 30;
  const framesPerScan = 6;
  const params = Object.fromEntries(
    args
      .filter(a => a.includes('='))
      .map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]),
  );
  const {server, port} = await startServer(dist, 0);

  const driver = spawn('safaridriver', ['-p', String(PORT)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const stop = () => {
    driver.kill();
    server.close();
  };
  process.on('exit', stop);
  // safaridriver needs a moment before it will accept connections.
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
    console.error(`\nCould not start Safari: ${e.message}`);
    console.error('Run "safaridriver --enable" once, then try again.\n');
    stop();
    process.exitCode = 1;
    return;
  }
  const s = `/session/${session.sessionId}`;

  try {
    const qs = new URLSearchParams(params).toString();
    const url = `http://localhost:${port}/index.html${qs ? `?${qs}` : ''}`;
    console.log(`[safari] ${session.capabilities?.browserVersion ?? ''} ${url}`);
    await send('POST', `${s}/url`, {url});

    // Poll from here rather than inside one long script: Safari caps a single
    // script at 30 seconds, and generating the world takes longer than that.
    await send('POST', `${s}/timeouts`, {script: 60000});
    const peek = () =>
      send('POST', `${s}/execute/sync`, {
        script: `return {gpu: !!navigator.gpu,
                         frame: window.__aquarium?.frame ?? -1,
                         errors: window.__aquarium?.errors ?? []};`,
        args: [],
      });
    const state = await peek();
    if (!state.gpu) {
      throw new Error('Safari reports no navigator.gpu');
    }
    // Safari's automation window is hidden, so requestAnimationFrame never
    // fires in it: wait for the world, then drive every frame by hand.
    // Poll a flag with short scripts rather than awaiting inside one long
    // script: a single WebDriver script has a timeout, and building the world
    // takes longer than is comfortable inside one.
    // pump is the last thing main() defines, so its presence means the world
    // is built. (Not __aquarium.ready: that only resolves once a frame has
    // been drawn, and here nothing draws a frame until this script does.)
    let built = false;
    for (let i = 0; i < 180; i++) {
      const st = await send('POST', `${s}/execute/sync`, {
        script: `return {pump: typeof window.__aquarium?.pump === 'function',
                         errors: window.__aquarium?.errors ?? []};`,
        args: [],
      });
      if (st.errors.length) {
        throw new Error(st.errors.join('; '));
      }
      if (st.pump) {
        built = true;
        break;
      }
      if (i % 15 === 14) {
        console.log(`[safari] still building (${i + 1}s)`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!built) {
      throw new Error('world did not build');
    }
    const started = await send('POST', `${s}/execute/async`, {
      script: asyncScript(
        'await window.__aquarium.pump(4); return window.__aquarium.frame;',
      ),
      args: [],
    });
    if (started.err) {
      throw new Error(started.err);
    }
    console.log(`[safari] world built, frame ${started.ok}`);

    let worst = null;
    let hits = 0;
    let nanTotal = 0;
    let infTotal = 0;
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      const r = await send('POST', `${s}/execute/async`, {
        script: asyncScript(`
          await window.__aquarium.pump(${framesPerScan});
          const r = await window.__aquarium.scanHdr();
          return {nan: r.nan, inf: r.inf, over8: r.over8, top: r.top.slice(0, 4),
                  nanAt: r.nanAt, frame: window.__aquarium.frame};`),
        args: [],
      });
      if (r.err) {
        console.log(`[scan] ${r.err}`);
        break;
      }
      const v = r.ok;
      const max = v.top[0]?.v ?? 0;
      if (v.nan || v.inf || max > 64) {
        hits++;
        nanTotal += v.nan;
        infTotal += v.inf;
        console.log(
          `[flash] frame ${v.frame}: nan ${v.nan}, inf ${v.inf}, ` +
            `over 8 ${v.over8}, brightest ${max.toFixed(1)} — ` +
            v.top.map(t => `(${t.x},${t.y})=${t.v.toFixed(0)}`).join(' ') +
            (v.nanAt?.length
              ? ` — NaN at ${v.nanAt.map(t => `(${t.x},${t.y})`).join(' ')}`
              : ''),
        );
        if (!worst || max > worst.max || v.nan > (worst.nan ?? 0)) {
          worst = {max, nan: v.nan, inf: v.inf, frame: v.frame};
          const shot = await send('GET', `${s}/screenshot`);
          await fs.mkdir('screenshots/dev', {recursive: true});
          await fs.writeFile(
            'screenshots/dev/safari-flash.png',
            Buffer.from(shot, 'base64'),
          );
        }
      }
    }
    console.log(
      hits
        ? `\n[safari] RESULT ${hits} bad frames, ${nanTotal} NaN pixels, ` +
            `${infTotal} infinite, worst ${JSON.stringify(worst)}\n` +
            'screenshots/dev/safari-flash.png'
        : `\n[safari] RESULT clean, 0 NaN pixels in ${seconds}s`,
    );
  } finally {
    await send('DELETE', s).catch(() => {});
    stop();
  }
}

await main();
