export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic uniform [0, 1) for (seed, index). */
export function rand(seed: number, i: number): number {
  let t = (seed ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Deterministic standard normal for (seed, index). */
export function gauss(seed: number, i: number): number {
  const u = Math.max(rand(seed, 2 * i), 1e-12);
  const v = rand(seed, 2 * i + 1);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const round = (x: number, sig = 7) => Number(x.toPrecision(sig));
