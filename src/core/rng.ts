// Seeded pseudo random numbers. Every generated asset derives from one seed so
// a run can be reproduced with ?seed=N.

/** Mixes a 32-bit integer (lowbias32 hash). */
export function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hashes a string to a 32-bit seed. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return hash32(h);
}

/** xoshiro128** generator. */
export class Rng {
  private s = new Uint32Array(4);

  constructor(seed: number) {
    let x = seed >>> 0;
    for (let i = 0; i < 4; i++) {
      x = hash32(x + 0x9e3779b9 * (i + 1));
      this.s[i] = x || 1;
    }
  }

  /** A child generator with an independent stream, e.g. rng.fork('coral'). */
  fork(name: string): Rng {
    return new Rng(hashString(name) ^ this.nextU32());
  }

  nextU32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  bool(p = 0.5): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.float() * items.length)];
  }

  /** Picks by weight. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.float() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) {
        return items[i];
      }
    }
    return items[items.length - 1];
  }

  /** Standard normal via Box-Muller. */
  normal(mean = 0, stddev = 1): number {
    const u = 1 - this.float();
    const v = this.float();
    return (
      mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    );
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

function rotl(x: number, k: number) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
