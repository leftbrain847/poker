/**
 * Equity: preflop from the precomputed class table (with exact card removal), postflop by exact
 * enumeration on the turn and river and seeded Monte Carlo on the flop.
 */
import { CARD_REMOVAL, CLASSES, COMBO_CLASS, COMBOS, NUM_CLASSES, NUM_COMBOS, type Card } from './cards';
import { evaluate } from './eval';
import { PREFLOP_EQUITY_B64 } from './preflop-equity.data';

function decode(b64: string): Float64Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Float64Array(NUM_CLASSES * NUM_CLASSES);
  for (let k = 0; k < out.length; k++) out[k] = (bin.charCodeAt(2 * k) | (bin.charCodeAt(2 * k + 1) << 8)) / 65535;
  return out;
}

/** EQ[i * 169 + j]: all-in preflop equity of class i against class j. */
export const EQ = decode(PREFLOP_EQUITY_B64);
export const eqClass = (i: number, j: number): number => EQ[i * NUM_CLASSES + j]!;

/** A preflop range: weight 0..1 per class (the share of that class's combos in the range). */
export type ClassRange = Float64Array;
export const fullRange = (): ClassRange => new Float64Array(NUM_CLASSES).fill(1);

/** Combos of a range that can coexist with a hand of class `hero` (exact average card removal). */
export function rangeCombos(r: ClassRange, hero: number | null = null): number {
  let n = 0;
  for (let j = 0; j < NUM_CLASSES; j++) {
    const w = r[j]!;
    if (w > 0) n += w * (hero === null ? CLASSES[j]!.combos : CARD_REMOVAL[hero * NUM_CLASSES + j]!);
  }
  return n;
}

/** Fraction of all 1326 combos in the range. */
export const rangeFraction = (r: ClassRange): number => rangeCombos(r) / NUM_COMBOS;

/** Equity of class `hero` against a range, weighting each class by its combos left after card removal. */
export function eqVsRange(hero: number, r: ClassRange): number {
  let w = 0;
  let e = 0;
  for (let j = 0; j < NUM_CLASSES; j++) {
    const rj = r[j]!;
    if (rj <= 0) continue;
    const c = rj * CARD_REMOVAL[hero * NUM_CLASSES + j]!;
    w += c;
    e += c * EQ[hero * NUM_CLASSES + j]!;
  }
  return w > 0 ? e / w : 0.5;
}

/** Equity of range a against range b (combo-weighted, with card removal). */
export function rangeVsRange(a: ClassRange, b: ClassRange): number {
  let w = 0;
  let e = 0;
  for (let i = 0; i < NUM_CLASSES; i++) {
    const ai = a[i]!;
    if (ai <= 0) continue;
    for (let j = 0; j < NUM_CLASSES; j++) {
      const bj = b[j]!;
      if (bj <= 0) continue;
      const c = ai * CLASSES[i]!.combos * bj * CARD_REMOVAL[i * NUM_CLASSES + j]!;
      w += c;
      e += c * EQ[i * NUM_CLASSES + j]!;
    }
  }
  return w > 0 ? e / w : 0.5;
}

// ---- Postflop: ranges over the 1326 combos.

export type ComboRange = Float64Array;

/** Zero out combos that touch a dead card (the board, a known hand). */
export function withoutDead(r: ComboRange, dead: ArrayLike<Card>): ComboRange {
  const out = new Float64Array(r);
  const d = new Uint8Array(52);
  for (let i = 0; i < dead.length; i++) d[dead[i]!] = 1;
  for (let k = 0; k < NUM_COMBOS; k++) {
    const [a, b] = COMBOS[k]!;
    if (d[a] || d[b]) out[k] = 0;
  }
  return out;
}

export function classToCombo(r: ClassRange): ComboRange {
  const out = new Float64Array(NUM_COMBOS);
  for (let k = 0; k < NUM_COMBOS; k++) out[k] = r[COMBO_CLASS[k]!]!;
  return out;
}

export const comboWeight = (r: ComboRange): number => {
  let s = 0;
  for (let k = 0; k < NUM_COMBOS; k++) s += r[k]!;
  return s;
};

const seven = new Int32Array(7);

/**
 * Equity of hero's two cards against each opponent's combo range, on a board of 3-5 cards.
 * Multiway when several ranges are given (hero must beat all). River: exact. Turn: exact over the
 * river cards heads-up, sampled multiway. Flop: `samples` seeded Monte Carlo draws.
 */
export function equityVsRanges(hero: [Card, Card], board: Card[], ranges: ComboRange[], rand: () => number, samples = 1500): number {
  const dead = [hero[0], hero[1], ...board];
  const live = ranges.map((r) => withoutDead(r, dead));
  if (live.some((r) => comboWeight(r) <= 0)) return 1;
  if (ranges.length === 1 && board.length >= 4) return exactHeadsUp(hero, board, live[0]!);
  return monteCarlo(hero, board, live, rand, samples);
}

function exactHeadsUp(hero: [Card, Card], board: Card[], r: ComboRange): number {
  const used = new Uint8Array(52);
  for (const c of [...hero, ...board]) used[c] = 1;
  const rivers = board.length === 5 ? [-1] : Array.from({ length: 52 }, (_, i) => i).filter((c) => !used[c]);
  let win = 0;
  let tot = 0;
  for (let k = 0; k < NUM_COMBOS; k++) {
    const w = r[k]!;
    if (w <= 0) continue;
    const [a, b] = COMBOS[k]!;
    for (const rv of rivers) {
      if (rv === a || rv === b) continue;
      const n = board.length;
      for (let i = 0; i < n; i++) seven[2 + i] = board[i]!;
      if (rv >= 0) seven[2 + n] = rv;
      const len = rv >= 0 ? n + 3 : n + 2;
      seven[0] = hero[0];
      seven[1] = hero[1];
      const vh = evaluate(seven, len);
      seven[0] = a;
      seven[1] = b;
      const vv = evaluate(seven, len);
      win += w * (vh > vv ? 1 : vh === vv ? 0.5 : 0);
      tot += w;
    }
  }
  return tot > 0 ? win / tot : 0.5;
}

/** Cumulative weights for sampling a combo from a range. */
function cdf(r: ComboRange): Float64Array {
  const c = new Float64Array(NUM_COMBOS);
  let s = 0;
  for (let k = 0; k < NUM_COMBOS; k++) {
    s += r[k]!;
    c[k] = s;
  }
  return c;
}

function sample(c: Float64Array, u: number): number {
  const x = u * c[NUM_COMBOS - 1]!;
  let lo = 0;
  let hi = NUM_COMBOS - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid]! > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function monteCarlo(hero: [Card, Card], board: Card[], live: ComboRange[], rand: () => number, samples: number): number {
  const cdfs = live.map(cdf);
  const used = new Uint8Array(52);
  let win = 0;
  let n = 0;
  let guard = 0;
  const opp: number[] = [];
  while (n < samples && guard < samples * 20) {
    guard++;
    used.fill(0);
    for (const c of hero) used[c] = 1;
    for (const c of board) used[c] = 1;
    opp.length = 0;
    let clash = false;
    for (const cd of cdfs) {
      const [a, b] = COMBOS[sample(cd, rand())]!;
      if (used[a] || used[b]) {
        clash = true;
        break;
      }
      used[a] = used[b] = 1;
      opp.push(a, b);
    }
    if (clash) continue;
    const full = board.slice();
    while (full.length < 5) {
      const c = Math.floor(rand() * 52);
      if (used[c]) continue;
      used[c] = 1;
      full.push(c);
    }
    for (let i = 0; i < 5; i++) seven[2 + i] = full[i]!;
    seven[0] = hero[0];
    seven[1] = hero[1];
    const vh = evaluate(seven, 7);
    let best = 0;
    let ties = 0;
    for (let o = 0; o < opp.length; o += 2) {
      seven[0] = opp[o]!;
      seven[1] = opp[o + 1]!;
      const v = evaluate(seven, 7);
      if (v > best) {
        best = v;
        ties = 0;
      }
      if (v === best) ties++;
    }
    if (vh > best) win += 1;
    else if (vh === best) win += 1 / (ties + 1);
    n++;
  }
  return n > 0 ? win / n : 0.5;
}

/**
 * Each combo's equity against an opponent range on this board, for ranking a whole range by strength
 * (used for the range-percentile view of postflop strategy). River: exact via sorting.
 * Earlier streets: `samples` seeded draws per combo (coarse but unbiased).
 */
export function comboEquities(mine: ComboRange, board: Card[], opp: ComboRange, rand: () => number, samples = 24): Float64Array {
  const out = new Float64Array(NUM_COMBOS);
  const liveMine = withoutDead(mine, board);
  const liveOpp = withoutDead(opp, board);
  if (board.length === 5) {
    const vals = new Float64Array(NUM_COMBOS);
    for (let i = 0; i < 5; i++) seven[2 + i] = board[i]!;
    const idx: number[] = [];
    for (let k = 0; k < NUM_COMBOS; k++) {
      if (liveMine[k]! <= 0 && liveOpp[k]! <= 0) continue;
      const [a, b] = COMBOS[k]!;
      seven[0] = a;
      seven[1] = b;
      vals[k] = evaluate(seven, 7);
      if (liveOpp[k]! > 0) idx.push(k);
    }
    idx.sort((x, y) => vals[x]! - vals[y]!);
    const vs = idx.map((k) => vals[k]!);
    const cum: number[] = [];
    let s = 0;
    for (const k of idx) {
      s += liveOpp[k]!;
      cum.push(s);
    }
    const total = s;
    for (let k = 0; k < NUM_COMBOS; k++) {
      if (liveMine[k]! <= 0) continue;
      const v = vals[k]!;
      // weight of opp combos strictly below, and equal
      let lo = 0;
      let hi = vs.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (vs[m]! < v) lo = m + 1;
        else hi = m;
      }
      const below = lo > 0 ? cum[lo - 1]! : 0;
      let hi2 = lo;
      while (hi2 < vs.length && vs[hi2] === v) hi2++;
      const eqW = (hi2 > 0 ? cum[hi2 - 1]! : 0) - below;
      out[k] = total > 0 ? (below + eqW / 2) / total : 0.5;
    }
    return out;
  }
  const cd = cdf(liveOpp);
  if (cd[NUM_COMBOS - 1]! <= 0) return out.fill(1);
  const used = new Uint8Array(52);
  for (let k = 0; k < NUM_COMBOS; k++) {
    if (liveMine[k]! <= 0) continue;
    const [a, b] = COMBOS[k]!;
    let win = 0;
    let n = 0;
    let guard = 0;
    while (n < samples && guard < samples * 30) {
      guard++;
      const [c, d] = COMBOS[sample(cd, rand())]!;
      if (c === a || c === b || d === a || d === b) continue;
      used.fill(0);
      used[a] = used[b] = used[c] = used[d] = 1;
      for (const x of board) used[x] = 1;
      const full = board.slice();
      while (full.length < 5) {
        const x = Math.floor(rand() * 52);
        if (used[x]) continue;
        used[x] = 1;
        full.push(x);
      }
      for (let i = 0; i < 5; i++) seven[2 + i] = full[i]!;
      seven[0] = a;
      seven[1] = b;
      const vh = evaluate(seven, 7);
      seven[0] = c;
      seven[1] = d;
      const vv = evaluate(seven, 7);
      win += vh > vv ? 1 : vh === vv ? 0.5 : 0;
      n++;
    }
    out[k] = n > 0 ? win / n : 0.5;
  }
  return out;
}
