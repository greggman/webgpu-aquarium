// Look controls: the Settings › Advanced sliders. Each is a uniform or a
// buffer the renderer reads every frame, so it changes the picture at once.
//
// Deliberately not saved: they are for playing with, and a remembered tweak
// would quietly change every ocean after. Each has a URL parameter instead,
// so a look worth keeping can be copied as a link.

import type {WorldDesc} from '../world/world.ts';

export interface Look {
  reefHue: number;
  reefMatch: number;
  reefSaturation: number;
  reefFade: number;
  fishLight: number;
  fishGlow: number;
  haze: number;
  shafts: number;
  ripples: number;
  brightness: number;
  contrast: number;
  saturation: number;
  vignette: number;
  grain: number;
}

export interface LookControl {
  key: keyof Look;
  /** URL parameter that sets it. */
  param: string;
  group: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const LOOK_CONTROLS: LookControl[] = [
  {
    key: 'reefHue',
    param: 'sethue',
    group: 'Reef',
    label: 'Colour',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'reefMatch',
    param: 'pull',
    group: 'Reef',
    label: 'Colours match',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'reefSaturation',
    param: 'setsat',
    group: 'Reef',
    label: 'Colourfulness',
    min: 0,
    max: 1.5,
    step: 0.01,
  },
  {
    key: 'reefFade',
    param: 'recede',
    group: 'Reef',
    label: 'Fades with distance',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'fishLight',
    param: 'key',
    group: 'Fish',
    label: 'Light on fish',
    min: 0,
    max: 2,
    step: 0.01,
  },
  {
    key: 'fishGlow',
    param: 'rim',
    group: 'Fish',
    label: 'Outline glow',
    min: 0,
    max: 15,
    step: 0.1,
  },
  {
    key: 'haze',
    param: 'fog',
    group: 'Water',
    label: 'Haze',
    min: 0,
    max: 1.5,
    step: 0.01,
  },
  {
    key: 'shafts',
    param: 'vol',
    group: 'Water',
    label: 'Light shafts',
    min: 0,
    max: 3,
    step: 0.01,
  },
  {
    key: 'ripples',
    param: 'caustics',
    group: 'Water',
    label: 'Ripple light',
    min: 0,
    max: 2,
    step: 0.01,
  },
  {
    key: 'brightness',
    param: 'exposure',
    group: 'Picture',
    label: 'Brightness',
    min: 0.4,
    max: 2,
    step: 0.01,
  },
  {
    key: 'contrast',
    param: 'contrast',
    group: 'Picture',
    label: 'Contrast',
    min: 0.6,
    max: 1.6,
    step: 0.01,
  },
  {
    key: 'saturation',
    param: 'saturation',
    group: 'Picture',
    label: 'Colour',
    min: 0,
    max: 2,
    step: 0.01,
  },
  {
    key: 'vignette',
    param: 'vignette',
    group: 'Picture',
    label: 'Dark corners',
    min: 0,
    max: 1.5,
    step: 0.01,
  },
  {
    key: 'grain',
    param: 'grain',
    group: 'Picture',
    label: 'Film grain',
    min: 0,
    max: 1,
    step: 0.01,
  },
];

/** The look this ocean was made with. */
export function defaultLook(desc: WorldDesc): Look {
  const g = desc.water.grade;
  return {
    reefHue: desc.colors.setHue,
    reefMatch: desc.colors.huePull,
    reefSaturation: desc.colors.setSaturation,
    reefFade: desc.colors.recession,
    fishLight: 0.6,
    fishGlow: 5,
    haze: 0.6,
    shafts: 1,
    ripples: 0.95,
    brightness: 1,
    contrast: g.contrast,
    saturation: g.saturation,
    vignette: g.vignette,
    grain: g.grain,
  };
}

/** The defaults with any URL parameters applied. */
export function lookFromParams(defaults: Look, params: URLSearchParams): Look {
  const look = {...defaults};
  for (const c of LOOK_CONTROLS) {
    const v = Number(params.get(c.param));
    if (params.has(c.param) && Number.isFinite(v)) {
      look[c.key] = v;
    }
  }
  return look;
}

/**
 * Query parameters for everything that differs from the defaults, on top of
 * `base`; the others are removed so the link stays short.
 */
export function lookParams(
  look: Look,
  defaults: Look,
  base: URLSearchParams,
): URLSearchParams {
  const q = new URLSearchParams(base);
  for (const c of LOOK_CONTROLS) {
    if (Math.abs(look[c.key] - defaults[c.key]) > c.step / 2) {
      q.set(c.param, String(+look[c.key].toFixed(3)));
    } else {
      q.delete(c.param);
    }
  }
  return q;
}
