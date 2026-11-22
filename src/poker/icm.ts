/**
 * ICM (Malmuth-Harville): each player's share of the prize pool from the stacks alone.
 * The chance a player finishes 1st is stack / total; later places follow recursively over who is left.
 * Exact for any table up to 9-10 players (DP over subsets).
 */

/** Equity of each player as a share of the total prize pool (sums to 1 when payouts sum to 1). */
export function icm(stacks: number[], payouts: number[]): number[] {
  const n = stacks.length;
  const out = new Array<number>(n).fill(0);
  const alive = stacks.map((s, i) => (s > 0 ? i : -1)).filter((i) => i >= 0);
  const m = alive.length;
  if (m === 0) return out;
  const pay = payouts.slice(0, m);
  const full = (1 << m) - 1;
  // prob[mask] = probability that exactly the players in `mask` are the ones already placed (from the top).
  const prob = new Float64Array(1 << m);
  prob[0] = 1;
  const st = alive.map((i) => stacks[i]!);
  const total = st.reduce((a, b) => a + b, 0);
  const sumOf = new Float64Array(1 << m);
  for (let mask = 1; mask <= full; mask++) {
    const low = mask & -mask;
    const b = 31 - Math.clz32(low);
    sumOf[mask] = sumOf[mask ^ low]! + st[b]!;
  }
  const bits = (x: number): number => {
    let c = 0;
    while (x) {
      x &= x - 1;
      c++;
    }
    return c;
  };
  for (let mask = 0; mask < full; mask++) {
    const p = prob[mask]!;
    if (p === 0) continue;
    const place = bits(mask);
    if (place >= pay.length) continue;
    const rem = total - sumOf[mask]!;
    if (rem <= 0) continue;
    for (let k = 0; k < m; k++) {
      if (mask & (1 << k)) continue;
      const q = (p * st[k]!) / rem;
      out[alive[k]!]! += q * pay[place]!;
      prob[mask | (1 << k)]! += q;
    }
  }
  return out;
}

/** Double-up payouts: the top half (floor) each get an equal share. */
export function doubleUpPayouts(players: number, paid: number = Math.floor(players / 2)): number[] {
  return Array.from({ length: players }, (_, i) => (i < paid ? 1 / paid : 0));
}

/**
 * Bubble factor of `hero` against `villain`: the $ hero loses by losing an all-in for the effective stack,
 * divided by the $ hero gains by winning it. 1.0 = chip EV; above 1 = losing hurts more than winning helps.
 */
export function bubbleFactor(stacks: number[], payouts: number[], hero: number, villain: number): number {
  const risk = Math.min(stacks[hero]!, stacks[villain]!);
  if (risk <= 0) return 1;
  const base = icm(stacks, payouts)[hero]!;
  const win = stacks.slice();
  win[hero]! += risk;
  win[villain]! -= risk;
  const lose = stacks.slice();
  lose[hero]! -= risk;
  lose[villain]! += risk;
  const gain = icm(win, payouts)[hero]! - base;
  const loss = base - icm(lose, payouts)[hero]!;
  return gain > 1e-12 ? loss / gain : 1;
}

/** Equity needed to call an all-in under ICM: risk-weighted pot odds with the bubble factor. */
export const icmRequiredEquity = (risk: number, reward: number, bf: number): number => (risk * bf) / (risk * bf + reward);
