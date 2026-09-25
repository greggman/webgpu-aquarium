// Viewer preferences, kept on this device only.
//
// Deliberately not in the URL. A link someone passes on should open the ocean
// as it comes, not as the sender happened to tune it for their machine — and
// the seed is kept out of the URL for the same reason. ?quality= still wins
// when present, so a report or a test can pin the tier without disturbing what
// the viewer chose.

import type {Tier} from './quality.ts';

export interface Settings {
  /** 'auto' leaves the tier to detectTier. */
  quality: Tier | 'auto';
  bloom: boolean;
  shadows: boolean;
  volumetrics: boolean;
  dof: boolean;
  grass: boolean;
  dust: boolean;
  /** Hold about 60 fps even on faster displays (less heat and fan). */
  frameCap: boolean;
}

export const QUALITY_CHOICES: Settings['quality'][] = [
  'auto',
  'mobile',
  'medium',
  'high',
  'ultra',
];

const KEY = 'aquarium:settings';
/** Survives the reload a quality change needs, so the ocean does not change. */
const SEED_KEY = 'aquarium:seed';

const DEFAULTS: Settings = {
  quality: 'auto',
  bloom: true,
  shadows: true,
  volumetrics: true,
  dof: true,
  grass: true,
  dust: true,
  frameCap: true,
};

export function loadSettings(): Settings {
  // Any of this can throw: private windows, blocked storage, a cleared origin.
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return {...DEFAULTS};
    }
    const v = JSON.parse(raw) as Partial<Settings>;
    return {
      quality: QUALITY_CHOICES.includes(v.quality as Settings['quality'])
        ? (v.quality as Settings['quality'])
        : 'auto',
      bloom: v.bloom !== false,
      shadows: v.shadows !== false,
      volumetrics: v.volumetrics !== false,
      dof: v.dof !== false,
      grass: v.grass !== false,
      dust: v.dust !== false,
      frameCap: v.frameCap !== false,
    };
  } catch {
    return {...DEFAULTS};
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}

/** Reloads to rebuild the world, keeping the ocean the viewer was looking at. */
export function reloadKeepingSeed(seed: number) {
  try {
    sessionStorage.setItem(SEED_KEY, String(seed));
  } catch {
    // Then they get a new ocean; the setting still applies.
  }
  location.reload();
}

/** The seed stashed by reloadKeepingSeed, used once and forgotten. */
export function takeKeptSeed(): number | null {
  try {
    const v = sessionStorage.getItem(SEED_KEY);
    sessionStorage.removeItem(SEED_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}
