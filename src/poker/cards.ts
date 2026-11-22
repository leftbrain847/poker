/**
 * Cards, hand classes, combos and a seeded RNG. Pure and deterministic.
 * A card is rank * 4 + suit: rank 0..12 is 2..A, suit 0..3 is c d h s.
 */
export type Card = number;

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const NUM_CLASSES = 169;
export const NUM_COMBOS = 1326;

export const rankOf = (c: Card): number => c >> 2;
export const suitOf = (c: Card): number => c & 3;
export const cardName = (c: Card): string => `${RANKS[rankOf(c)]}${SUITS[suitOf(c)]}`;

export function parseCard(s: string): Card {
  const r = RANKS.indexOf(s[0] ?? '');
  const u = SUITS.indexOf(s[1] ?? '');
  if (r < 0 || u < 0) throw new Error(`bad card ${s}`);
  return r * 4 + u;
}

/** mulberry32: small, fast, same sequence in every JS engine. Returns a function giving floats in [0,1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes numbers into one 32-bit seed (for per-hand and per-decision streams). */
export function mix(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
  }
  return h >>> 0;
}

export function shuffled(seed: number): Card[] {
  const r = rng(seed);
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = d[i]!;
    d[i] = d[j]!;
    d[j] = t;
  }
  return d;
}

// ---- Hand classes (169): index = hi*13 + lo for suited (hi > lo), lo*13 + hi for offsuit, r*13 + r for pairs.
// That is the usual 13x13 grid: row = first rank, col = second rank (both from A down when drawn).

/** Class index for two hole cards. Grid convention: suited above the diagonal (row hi, col lo). */
export function classOf(a: Card, b: Card): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  if (hi === lo) return hi * 13 + hi;
  return suitOf(a) === suitOf(b) ? hi * 13 + lo : lo * 13 + hi;
}

export interface ClassInfo {
  hi: number;
  lo: number;
  pair: boolean;
  suited: boolean;
  combos: number;
  name: string;
}

export const CLASSES: ClassInfo[] = Array.from({ length: NUM_CLASSES }, (_, i) => {
  const r = Math.floor(i / 13);
  const c = i % 13;
  const pair = r === c;
  const suited = r > c;
  const hi = Math.max(r, c);
  const lo = Math.min(r, c);
  const name = pair ? `${RANKS[hi]}${RANKS[hi]}` : `${RANKS[hi]}${RANKS[lo]}${suited ? 's' : 'o'}`;
  return { hi, lo, pair, suited, combos: pair ? 6 : suited ? 4 : 12, name };
});

export const classByName = (name: string): number => {
  const i = CLASSES.findIndex((c) => c.name === name);
  if (i < 0) throw new Error(`bad class ${name}`);
  return i;
};

/** All 1326 two-card combos, a < b, and their class. */
export const COMBOS: [Card, Card][] = [];
export const COMBO_CLASS = new Uint8Array(NUM_COMBOS);
export const COMBO_INDEX = new Int16Array(52 * 52).fill(-1);
for (let a = 0; a < 52; a++) {
  for (let b = a + 1; b < 52; b++) {
    const i = COMBOS.length;
    COMBOS.push([a, b]);
    COMBO_CLASS[i] = classOf(a, b);
    COMBO_INDEX[a * 52 + b] = i;
    COMBO_INDEX[b * 52 + a] = i;
  }
}
export const CLASS_COMBOS: number[][] = Array.from({ length: NUM_CLASSES }, () => []);
COMBOS.forEach((_, i) => CLASS_COMBOS[COMBO_CLASS[i]!]!.push(i));

export const comboIndex = (a: Card, b: Card): number => COMBO_INDEX[a * 52 + b]!;

/**
 * Card removal: CR[i * 169 + j] = average number of combos of class j that do not share a card with
 * a combo of class i. Exact, so blockers (an ace in hand removes ace combos) count in every range calc.
 */
export const CARD_REMOVAL = (() => {
  const t = new Float64Array(NUM_CLASSES * NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i++) {
    const mine = CLASS_COMBOS[i]!;
    for (let j = 0; j < NUM_CLASSES; j++) {
      let n = 0;
      for (const m of mine) {
        const [a, b] = COMBOS[m]!;
        for (const o of CLASS_COMBOS[j]!) {
          const [c, d] = COMBOS[o]!;
          if (c !== a && c !== b && d !== a && d !== b) n++;
        }
      }
      t[i * NUM_CLASSES + j] = n / mine.length;
    }
  }
  return t;
})();
