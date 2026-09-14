// Shared puppeteer helpers for smoke tests and screenshot capture.
import puppeteer from 'puppeteer';
import path from 'node:path';
import {startServer} from '../scripts/serve.mjs';

const dist = path.resolve(import.meta.dirname, '../dist');

export async function launch() {
  const {server, port} = await startServer(dist, 0);
  // No special flags: headless Chrome supports WebGPU out of the box.
  const browser = await puppeteer.launch({headless: true, args: []});
  return {
    browser,
    base: `http://localhost:${port}/`,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/**
 * Opens the aquarium with the given query params and waits until it is ready.
 * Returns the page plus the log lines captured so far.
 */
export async function openAquarium(ctx, params = {}, viewport = {}) {
  const page = await ctx.browser.newPage();
  await page.setViewport({width: 1280, height: 720, ...viewport});
  const logs = [];
  page.on('console', m => {
    const line = `[page:${m.type()}] ${m.text()}`;
    logs.push(line);
    console.log(line);
  });
  page.on('pageerror', e => {
    const line = `[pageerror] ${e.message}`;
    logs.push(line);
    console.log(line);
  });
  const qs = new URLSearchParams(params).toString();
  await page.goto(`${ctx.base}index.html${qs ? '?' + qs : ''}`, {
    waitUntil: 'load',
  });
  await page.waitForFunction('window.__aquarium', {timeout: 30000});
  await Promise.race([
    page.evaluate(() => window.__aquarium.ready),
    page.waitForFunction('window.__aquarium.errors.length > 0', {
      timeout: 120000,
    }),
  ]);
  return {page, logs};
}

export async function waitFrames(page, n) {
  const start = await page.evaluate(() => window.__aquarium.frame);
  await page.waitForFunction(`window.__aquarium.frame >= ${start + n}`, {
    timeout: 120000,
  });
}

export async function getErrors(page) {
  return page.evaluate(() => window.__aquarium.errors);
}

/**
 * Screenshots the canvas via the compositor (not canvas.toDataURL, which can
 * read back a cleared buffer) and returns {png, stats}.
 */
export async function capture(page, file) {
  const el = await page.$('#screen');
  const png = await el.screenshot(file ? {path: file} : {});
  const b64 = Buffer.from(png).toString('base64');
  const stats = await page.evaluate(async b64 => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    const ctx2d = c.getContext('2d');
    ctx2d.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx2d.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let sum2 = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l;
      sum2 += l * l;
    }
    const mean = sum / n;
    return {mean, stddev: Math.sqrt(Math.max(0, sum2 / n - mean * mean))};
  }, b64);
  return {png, stats};
}
