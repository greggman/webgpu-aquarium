// A friendly full-screen explanation when WebGPU can't start, with advice for
// what went wrong.

import type {UnavailableReason} from './device.ts';

/** Linux (not Android) is the one desktop platform where support still varies. */
function isLinux(ua: string): boolean {
  return /Linux/.test(ua) && !/Android/.test(ua);
}

function advice(reason: UnavailableReason): string[] {
  const ua = navigator.userAgent;
  switch (reason) {
    case 'insecure-context':
      return [
        'WebGPU only works on secure pages. Open this page over https:// ' +
          '(or from localhost when running it yourself).',
      ];
    case 'no-adapter':
    case 'no-device':
      return [
        'Your browser supports WebGPU but could not get access to a suitable GPU.',
        'Make sure hardware acceleration is enabled in your browser settings and ' +
          'your graphics drivers are up to date.',
        'Closing other GPU-heavy tabs or restarting the browser can also help.',
      ];
    case 'no-context':
      return [
        'The page could not create a WebGPU canvas. Try reloading, or restarting the browser.',
      ];
    case 'no-api':
      break;
  }
  const lines = [
    'Current versions of Chrome, Edge, Firefox and Safari all support WebGPU. ' +
      'Updating your browser should fix this.',
  ];
  if (isLinux(ua)) {
    lines.push(
      'On Linux, WebGPU support depends on the browser and GPU driver and may ' +
        'not be available yet.',
    );
  }
  return lines;
}

export function showUnsupported(reason: UnavailableReason) {
  document.getElementById('loading')?.remove();
  document.getElementById('screen')?.remove();
  const panel = document.createElement('div');
  panel.id = 'unsupported';
  const h = document.createElement('h1');
  h.textContent = 'This aquarium needs WebGPU';
  const intro = document.createElement('p');
  intro.textContent =
    'The ocean is generated and rendered on your graphics card with WebGPU, ' +
    'which is not available here.';
  const list = document.createElement('ul');
  for (const line of advice(reason)) {
    const li = document.createElement('li');
    li.textContent = line;
    list.append(li);
  }
  const more = document.createElement('p');
  more.className = 'more';
  const link = document.createElement('a');
  link.href = 'https://caniuse.com/webgpu';
  link.textContent = 'Which browsers support WebGPU?';
  link.target = '_blank';
  link.rel = 'noopener';
  more.append(link);
  const card = document.createElement('div');
  card.className = 'card';
  card.append(h, intro, list, more);
  panel.append(card);
  document.body.append(panel);
}
