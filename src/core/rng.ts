/**
 * Deterministic, serializable pseudo random number generator.
 *
 * Requirements this satisfies:
 *   - Same seed plus same call sequence yields identical results forever.
 *   - State is four unsigned 32 bit integers, so it round trips through JSON in a save
 *     file with no precision loss and no reliance on Math.random.
 *   - Cheap enough to call millions of times during batch calibration runs.
 *
 * Algorithm is xoshiro128 star star, seeded through splitmix32 so that a weak seed such
 * as 1 still produces a well mixed state.
 */

export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^= t >>> 15) >>> 0;
  };
}

/** Turns any string into a 32 bit seed. Used for named sub streams. */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  /** Number of raw draws taken. Useful for reproducibility assertions in tests. */
  public draws = 0;

  constructor(seed: number | RngState | string) {
    if (typeof seed === 'object') {
      this.s0 = seed.s0 >>> 0;
      this.s1 = seed.s1 >>> 0;
      this.s2 = seed.s2 >>> 0;
      this.s3 = seed.s3 >>> 0;
    } else {
      const n = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
      const sm = splitmix32(n === 0 ? 0x1a2b3c4d : n);
      this.s0 = sm();
      this.s1 = sm();
      this.s2 = sm();
      this.s3 = sm();
      if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    }
  }

  getState(): RngState {
    return { s0: this.s0, s1: this.s1, s2: this.s2, s3: this.s3 };
  }

  setState(st: RngState): void {
    this.s0 = st.s0 >>> 0;
    this.s1 = st.s1 >>> 0;
    this.s2 = st.s2 >>> 0;
    this.s3 = st.s3 >>> 0;
  }

  /** Raw 32 bit unsigned draw. */
  nextUint32(): number {
    this.draws++;
    const r = Math.imul(this.s1, 5);
    const result = Math.imul(((r << 7) | (r >>> 25)) >>> 0, 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return result;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }

  /** Standard normal via Box Muller. Cached second value is intentionally discarded so
   *  the draw count stays a simple function of call count. */
  normal(mean = 0, sd = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Normal clamped to a range. Used constantly for attribute generation. */
  normalClamped(mean: number, sd: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, this.normal(mean, sd)));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  /** Weighted pick. Weights need not sum to one. Non positive weights are skipped. */
  weighted<T>(items: readonly T[], weightOf: (item: T, index: number) => number): T {
    let total = 0;
    const weights: number[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const w = Math.max(0, weightOf(items[i], i));
      weights[i] = w;
      total += w;
    }
    if (total <= 0) return items[this.int(0, items.length - 1)];
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** Derives an independent named stream. Lets one subsystem draw without shifting the
   *  draw sequence of another, which keeps cross subsystem determinism stable when a
   *  feature is added later. */
  fork(name: string): Rng {
    return new Rng((hashString(name) ^ this.nextUint32()) >>> 0);
  }
}

/** Logistic curve. The core opposed check throughout the fight engine. */
export function sigmoid(x: number): number {
  if (x > 40) return 1;
  if (x < -40) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/** Maps a value from one range to another with clamping. */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  return clamp(outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin), Math.min(outMin, outMax), Math.max(outMin, outMax));
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / (values.length - 1));
}

export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = clamp(p, 0, 1) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return lerp(sortedAsc[lo], sortedAsc[hi], idx - lo);
}
