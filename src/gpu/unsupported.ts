// A friendly full-screen explanation when WebGPU can't start, with advice for
// the browser the visitor is actually using.

import type {UnavailableReason} from './device.ts';

type Browser = 'safari-ios' | 'safari' | 'firefox' | 'chromium' | 'other';

function detectBrowser(ua: string): Browser {
  const iOS =
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // Every browser on iOS uses Safari's engine.
  if (iOS) {
    return 'safari-ios';
  }
  if (/Firefox\//.test(ua)) {
    return 'firefox';
  }
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) {
    return 'chromium';
  }
  if (/Safari\//.test(ua)) {
    return 'safari';
  }
  return 'other';
}

function advice(reason: UnavailableReason, browser: Browser): string[] {
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
        browser === 'chromium'
          ? 'Make sure hardware acceleration is turned on (Settings → System) ' +
            'and check chrome://gpu for WebGPU status; your GPU or driver may be blocklisted.'
          : 'Make sure hardware acceleration is enabled and your graphics drivers are up to date.',
        'Closing other GPU-heavy tabs or restarting the browser can also help.',
      ];
    case 'no-context':
      return [
        'The page could not create a WebGPU canvas. Try reloading, or restarting the browser.',
      ];
    case 'no-api':
      break;
  }
  switch (browser) {
    case 'safari-ios':
      return [
        'Update to iOS / iPadOS 26 or later, where WebGPU is on by default.',
        'On older versions you can try Settings → Apps → Safari → Advanced → ' +
          'Feature Flags → WebGPU.',
      ];
    case 'safari':
      return [
        'Update to Safari 26 (macOS 26 Tahoe) or later, where WebGPU is on by default.',
        'Or use a recent Chrome or Edge.',
      ];
    case 'firefox':
      return [
        'WebGPU is on by default in recent Firefox on Windows and macOS. ' +
          'Update Firefox, or enable dom.webgpu.enabled in about:config.',
        'Or use a recent Chrome or Edge.',
      ];
    case 'chromium':
      return [
        'Update your browser: WebGPU is on by default in Chrome and Edge 113 and later.',
        'On Linux it may still need enabling at chrome://flags/#enable-unsafe-webgpu.',
      ];
    default:
      return [
        'Please use a recent version of Chrome, Edge, Safari or Firefox.',
      ];
  }
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
  for (const line of advice(reason, detectBrowser(navigator.userAgent))) {
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
