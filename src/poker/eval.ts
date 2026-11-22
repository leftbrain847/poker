/**
 * Hand evaluator for 5 to 7 cards. Returns a number where higher beats lower and equal ties.
 * Layout: category << 20 | five 4-bit rank slots (most significant first).
 * Categories: 8 straight flush, 7 quads, 6 full house, 5 flush, 4 straight, 3 trips, 2 two pair, 1 pair, 0 high card.
 */
import type { Card } from './cards';

export const CATEGORY_NAMES = ['High card', 'Pair', 'Two pair', 'Trips', 'Straight', 'Flush', 'Full house', 'Quads', 'Straight flush'];

/** STRAIGHT_TOP[mask] = top rank of the best straight in a 13-bit rank mask, or -1. Ace plays low in A-5. */
const STRAIGHT_TOP = new Int8Array(8192).fill(-1);
for (let m = 0; m < 8192; m++) {
  for (let top = 12; top >= 3; top--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      const r = top - k;
      const bit = r < 0 ? 12 : r; // the wheel: the ace plays as the low card
      if (!(m & (1 << bit))) {
        ok = false;
        break;
      }
    }
    if (ok) {
      STRAIGHT_TOP[m] = top;
      break;
    }
  }
}

const counts = new Uint8Array(13);
const suitMask = new Uint16Array(4);
const suitCount = new Uint8Array(4);

function topBits(mask: number, n: number): number {
  let v = 0;
  let got = 0;
  for (let r = 12; r >= 0 && got < n; r--) {
    if (mask & (1 << r)) {
      v = (v << 4) | r;
      got++;
    }
  }
  return v << (4 * (5 - got));
}

export function evaluate(cards: ArrayLike<Card>, n: number = cards.length): number {
  counts.fill(0);
  suitMask.fill(0);
  suitCount.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i]!;
    const r = c >> 2;
    const s = c & 3;
    counts[r]!++;
    suitMask[s]! |= 1 << r;
    suitCount[s]!++;
    rankMask |= 1 << r;
  }
  for (let s = 0; s < 4; s++) {
    if (suitCount[s]! >= 5) {
      const sm = suitMask[s]!;
      const st = STRAIGHT_TOP[sm]!;
      if (st >= 0) return (8 << 20) | (st << 16);
      return (5 << 20) | topBits(sm, 5);
    }
  }
  let quad = -1;
  let trip1 = -1;
  let trip2 = -1;
  let pair1 = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const k = counts[r]!;
    if (k === 4) quad = r;
    else if (k === 3) {
      if (trip1 < 0) trip1 = r;
      else if (trip2 < 0) trip2 = r;
    } else if (k === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
    }
  }
  if (quad >= 0) return (7 << 20) | (quad << 16) | (topBits(rankMask & ~(1 << quad), 1) >> 4);
  if (trip1 >= 0 && (trip2 >= 0 || pair1 >= 0)) {
    const p = Math.max(trip2, pair1);
    return (6 << 20) | (trip1 << 16) | (p << 12);
  }
  const st = STRAIGHT_TOP[rankMask]!;
  if (st >= 0) return (4 << 20) | (st << 16);
  if (trip1 >= 0) return (3 << 20) | (trip1 << 16) | (topBits(rankMask & ~(1 << trip1), 2) >> 4);
  if (pair1 >= 0 && pair2 >= 0) {
    return (2 << 20) | (pair1 << 16) | (pair2 << 12) | (topBits(rankMask & ~(1 << pair1) & ~(1 << pair2), 1) >> 8);
  }
  if (pair1 >= 0) return (1 << 20) | (pair1 << 16) | (topBits(rankMask & ~(1 << pair1), 3) >> 4);
  return topBits(rankMask, 5);
}

export const categoryOf = (value: number): number => value >> 20;
