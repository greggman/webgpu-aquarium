import {spawn} from 'node:child_process';
import {startServer} from '../scripts/serve.mjs';
const PORT = 4455, base = `http://localhost:${PORT}`;
const send = async (m, r, b) => {
  const res = await fetch(`${base}${r}`, {method: m, headers: {'Content-Type': 'application/json'}, body: b === undefined ? undefined : JSON.stringify(b)});
  const j = await res.json().catch(() => ({}));
  if (j.value?.error) throw new Error(`${j.value.error}: ${j.value.message}`);
  return j.value;
};
const file = process.argv[2], which = process.argv[3] ?? "safari", qs = process.argv[4] ? "?" + process.argv[4] : "";
const {server, port} = await startServer(new URL('..', import.meta.url).pathname, 0);
const url = `http://localhost:${port}/${file}${qs}`;
if (which === 'chrome') {
  const puppeteer = (await import('puppeteer')).default;
  const b = await puppeteer.launch({headless: true});
  const p = await b.newPage();
  p.on('console', m => console.log('[page]', m.text()));
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.goto(url, {waitUntil: 'load'});
  await p.waitForFunction('window.__result', {timeout: 120000});
  console.log(JSON.stringify(await p.evaluate(() => window.__result), null, 1));
  await b.close();
} else {
  const drv = spawn('safaridriver', ['-p', String(PORT)], {stdio: 'inherit'});
  for (let i = 0; i < 40; i++) { try { await fetch(`${base}/status`); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  const sess = await send('POST', '/session', {capabilities: {alwaysMatch: {browserName: 'safari'}}});
  const s = `/session/${sess.sessionId}`;
  await send('POST', `${s}/timeouts`, {script: 60000});
  await send('POST', `${s}/url`, {url});
  let r = null;
  for (let i = 0; i < 90; i++) {
    r = await send('POST', `${s}/execute/sync`, {script: 'return window.__result ?? null;', args: []});
    if (r) break;
    await new Promise(x => setTimeout(x, 1000));
  }
  console.log(JSON.stringify(r, null, 1));
  await send('DELETE', s).catch(() => {});
  drv.kill();
}
server.close();
