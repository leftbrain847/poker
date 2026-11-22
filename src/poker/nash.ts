/**
 * ICM all-in equilibrium ("push/fold Nash"), the solved core of short-stack tournament play.
 *
 * Game: one player (the jammer) moves all in; the players behind each call or fold in turn; once one
 * calls, the rest fold (overcalls are not modelled, as in most push/fold calculators). Payoffs are each
 * player's ICM equity of the final stacks (or chip share, for an ICM-unaware model). Solved by
 * fictitious play over the 169 hand classes with exact card removal, which converges to the
 * equilibrium the standard ICM calculators report; mixed frequencies appear at the range edges.
 *
 * Also handles a re-jam over an open or a jam over callers: callers can carry a prior range
 * (the hands they arrived with) and money already committed.
 */
import { CARD_REMOVAL, CLASSES, NUM_CLASSES } from './cards';
import { EQ, type ClassRange } from './equity';
import { icm } from './icm';

export interface AllInSpot {
  /** Chips each player still has behind (not yet in the pot). */
  behind: number[];
  /** Chips each player has put in the pot this hand that count toward a call (blinds, raises). */
  bet: number[];
  /** Total pot now, including every bet and dead money such as antes. */
  pot: number;
  jammer: number;
  /** Players who may call, in the order they act. */
  callers: number[];
  /** Range each player holds before this decision (1 = all hands). Missing = all hands. */
  priors?: (ClassRange | undefined)[];
  payouts: number[];
  /** Who wins the pot if the jammer folds instead (usually the big blind). */
  foldWinner: number;
}

export interface SolveOptions {
  /** 1 = full ICM payoffs, 0 = chip EV. */
  icmWeight?: number;
  iterations?: number;
}

export interface AllInSolution {
  /** Jam frequency per class for the jammer. */
  jam: Float64Array;
  /** Call frequency per class for each caller (same order as spot.callers). */
  call: Float64Array[];
  /** EV(jam) - EV(fold) per class for the jammer, in prize-pool share (1 = the whole pool). */
  jamMargin: Float64Array;
  /** EV(call) - EV(fold) per class, per caller. */
  callMargin: Float64Array[];
}

type Utility = (stacks: number[]) => number[];

/** Margins smaller than this (share of the prize pool) count as indifferent, so the hand may mix. */
export const MIX_EPS = 0.0004;

const CREQ = (() => {
  const t = new Float64Array(NUM_CLASSES * NUM_CLASSES);
  for (let k = 0; k < t.length; k++) t[k] = CARD_REMOVAL[k]! * EQ[k]!;
  return t;
})();

export function utility(payouts: number[], icmWeight: number): Utility {
  return (stacks) => {
    const total = stacks.reduce((a, b) => a + b, 0);
    const prize = payouts.reduce((a, b) => a + b, 0);
    const chip = stacks.map((s) => (s / total) * prize);
    if (icmWeight <= 0) return chip;
    const ic = icm(stacks, payouts);
    return ic.map((v, i) => icmWeight * v + (1 - icmWeight) * chip[i]!);
  };
}

/** Final stacks for each way the all-in can end. */
export function outcomes(spot: AllInSpot) {
  const { behind, bet, pot, jammer: p } = spot;
  const base = behind.slice();
  const steal = base.slice();
  steal[p] = behind[p]! + pot;
  const fold = base.slice();
  fold[spot.foldWinner] = behind[spot.foldWinner]! + pot;
  const vs = spot.callers.map((c) => {
    const tp = bet[p]! + behind[p]!;
    const tc = bet[c]! + behind[c]!;
    const m = Math.min(tp, tc);
    const total = pot - bet[p]! - bet[c]! + 2 * m;
    const pw = base.slice();
    pw[p] = tp - m + total;
    pw[c] = tc - m;
    const cw = base.slice();
    cw[p] = tp - m;
    cw[c] = tc - m + total;
    return { pw, cw };
  });
  return { steal, fold, vs };
}

const priorOf = (spot: AllInSpot, seat: number): ClassRange => spot.priors?.[seat] ?? new Float64Array(NUM_CLASSES).fill(1);

/** Per-hand chance that caller m calls and the equity when it does, given the jammer holds class i. */
function callerStats(prior: ClassRange, strat: Float64Array, i: number): { pCall: number; eq: number } {
  let num = 0;
  let den = 0;
  let eqn = 0;
  const off = i * NUM_CLASSES;
  for (let j = 0; j < NUM_CLASSES; j++) {
    const pr = prior[j]!;
    if (pr <= 0) continue;
    const cr = CARD_REMOVAL[off + j]!;
    den += pr * cr;
    const a = pr * strat[j]!;
    if (a > 0) {
      num += a * cr;
      eqn += a * CREQ[off + j]!;
    }
  }
  return { pCall: den > 0 ? num / den : 0, eq: num > 0 ? eqn / num : 0.5 };
}

/** Combo-weighted share of a prior that a strategy keeps. */
export function keptShare(prior: ClassRange, strat: Float64Array): number {
  let k = 0;
  let t = 0;
  for (let j = 0; j < NUM_CLASSES; j++) {
    const w = prior[j]! * CLASSES[j]!.combos;
    t += w;
    k += w * strat[j]!;
  }
  return t > 0 ? k / t : 0;
}

/** Equity of a (prior x strategy) range against another, combo-weighted with card removal. */
function weightedRvR(pa: ClassRange, sa: Float64Array, pb: ClassRange, sb: Float64Array): number {
  let w = 0;
  let e = 0;
  for (let i = 0; i < NUM_CLASSES; i++) {
    const a = pa[i]! * sa[i]! * CLASSES[i]!.combos;
    if (a <= 0) continue;
    const off = i * NUM_CLASSES;
    for (let j = 0; j < NUM_CLASSES; j++) {
      const b = pb[j]! * sb[j]!;
      if (b <= 0) continue;
      const c = a * b * CARD_REMOVAL[off + j]!;
      w += c;
      e += c * EQ[off + j]!;
    }
  }
  return w > 0 ? e / w : 0.5;
}

/** EV(jam) and EV(fold) for the jammer holding class i, against fixed caller strategies. */
export function jammerEV(spot: AllInSpot, U: Utility, calls: Float64Array[], i: number) {
  const o = outcomes(spot);
  const p = spot.jammer;
  const uSteal = U(o.steal)[p]!;
  const uFold = U(o.fold)[p]!;
  let reach = 1;
  let ev = 0;
  spot.callers.forEach((c, m) => {
    const { pCall, eq } = callerStats(priorOf(spot, c), calls[m]!, i);
    const v = o.vs[m]!;
    ev += reach * pCall * (eq * U(v.pw)[p]! + (1 - eq) * U(v.cw)[p]!);
    reach *= 1 - pCall;
  });
  ev += reach * uSteal;
  return { jam: ev, fold: uFold, foldThrough: reach };
}

/** EV(call) and EV(fold) for caller index m holding class j, against a fixed jam range and later callers. */
export function callerEV(spot: AllInSpot, U: Utility, jam: Float64Array, calls: Float64Array[], m: number, j: number) {
  const o = outcomes(spot);
  const c = spot.callers[m]!;
  const pPrior = priorOf(spot, spot.jammer);
  // equity of class j against the jam range
  let w = 0;
  let e = 0;
  for (let i = 0; i < NUM_CLASSES; i++) {
    const a = pPrior[i]! * jam[i]!;
    if (a <= 0) continue;
    const cr = CARD_REMOVAL[j * NUM_CLASSES + i]!;
    w += a * cr;
    e += a * cr * EQ[j * NUM_CLASSES + i]!;
  }
  const eq = w > 0 ? e / w : 0.5;
  const v = o.vs[m]!;
  const call = eq * U(v.cw)[c]! + (1 - eq) * U(v.pw)[c]!;
  // folding: later callers may still play the jammer
  let reach = 1;
  let fold = 0;
  for (let l = m + 1; l < spot.callers.length; l++) {
    const cl = spot.callers[l]!;
    const pr = priorOf(spot, cl);
    const pCall = keptShare(pr, calls[l]!);
    const eqP = weightedRvR(pPrior, jam, pr, calls[l]!);
    const vl = o.vs[l]!;
    fold += reach * pCall * (eqP * U(vl.pw)[c]! + (1 - eqP) * U(vl.cw)[c]!);
    reach *= 1 - pCall;
  }
  fold += reach * U(o.steal)[c]!;
  return { call, fold, eq };
}

/** Solve the all-in game by fictitious play. */
export function solveAllIn(spot: AllInSpot, opts: SolveOptions = {}): AllInSolution {
  const U = memoUtility(utility(spot.payouts, opts.icmWeight ?? 1));
  const iters = opts.iterations ?? 80;
  const o = outcomes(spot);
  const p = spot.jammer;
  const k = spot.callers.length;
  const pPrior = priorOf(spot, p);
  const priors = spot.callers.map((c) => priorOf(spot, c));
  // Payoffs are constant per outcome: precompute every player's utility once.
  const uSteal = U(o.steal);
  const uFold = U(o.fold);
  const uPw = o.vs.map((v) => U(v.pw));
  const uCw = o.vs.map((v) => U(v.cw));

  let jam: Float64Array = new Float64Array(NUM_CLASSES).fill(0.3);
  let calls: Float64Array[] = spot.callers.map(() => new Float64Array(NUM_CLASSES).fill(0.15));
  const jamMargin = new Float64Array(NUM_CLASSES);
  const callMargin = spot.callers.map(() => new Float64Array(NUM_CLASSES));

  const step = (t: number) => {
    // Jammer best response.
    const brJam = new Float64Array(NUM_CLASSES);
    for (let i = 0; i < NUM_CLASSES; i++) {
      if (pPrior[i]! <= 0) continue;
      let reach = 1;
      let ev = 0;
      for (let m = 0; m < k; m++) {
        const { pCall, eq } = callerStats(priors[m]!, calls[m]!, i);
        ev += reach * pCall * (eq * uPw[m]![p]! + (1 - eq) * uCw[m]![p]!);
        reach *= 1 - pCall;
      }
      ev += reach * uSteal[p]!;
      jamMargin[i] = ev - uFold[p]!;
      brJam[i] = jamMargin[i]! > 0 ? 1 : 0;
    }
    // Callers' best responses against the current jam range. Later callers' call chance and equity
    // against the jam range don't depend on an earlier caller's hand: compute them once per iteration.
    const pCallAvg = priors.map((pr, l) => keptShare(pr, calls[l]!));
    const eqVsL = priors.map((pr, l) => weightedRvR(pPrior, jam, pr, calls[l]!));
    const brCalls = spot.callers.map((c, m) => {
      const br = new Float64Array(NUM_CLASSES);
      let reach = 1;
      let fold = 0;
      for (let l = m + 1; l < k; l++) {
        const pCall = pCallAvg[l]!;
        const eqP = eqVsL[l]!;
        fold += reach * pCall * (eqP * uPw[l]![c]! + (1 - eqP) * uCw[l]![c]!);
        reach *= 1 - pCall;
      }
      fold += reach * uSteal[c]!;
      for (let j = 0; j < NUM_CLASSES; j++) {
        if (priors[m]![j]! <= 0) continue;
        let w = 0;
        let e = 0;
        const off = j * NUM_CLASSES;
        for (let i = 0; i < NUM_CLASSES; i++) {
          const a = pPrior[i]! * jam[i]!;
          if (a <= 0) continue;
          w += a * CARD_REMOVAL[off + i]!;
          e += a * CREQ[off + i]!;
        }
        const eq = w > 0 ? e / w : 0.5;
        const call = eq * uCw[m]![c]! + (1 - eq) * uPw[m]![c]!;
        callMargin[m]![j] = call - fold;
        br[j] = call > fold ? 1 : 0;
      }
      return br;
    });
    const a = 1 / (t + 2);
    jam = jam.map((x, i) => x + a * (brJam[i]! - x));
    calls = calls.map((s, m) => s.map((x, j) => x + a * (brCalls[m]![j]! - x)));
  };
  for (let t = 0; t < iters; t++) step(t);
  // Fictitious play's average strategy blurs the range edge while it converges. A hand whose margin
  // against the final strategies is clearly positive or negative is pure; only near-indifferent hands mix.
  const settle = (s: Float64Array, margin: Float64Array) =>
    s.map((x, i) => (Math.abs(margin[i]!) < MIX_EPS ? x : margin[i]! > 0 ? 1 : 0));
  return { jam: settle(jam, jamMargin), call: calls.map((c, m) => settle(c, callMargin[m]!)), jamMargin, callMargin };
}

function memoUtility(U: Utility): Utility {
  const cache = new Map<string, number[]>();
  return (stacks) => {
    const key = stacks.join(',');
    let v = cache.get(key);
    if (!v) {
      v = U(stacks);
      cache.set(key, v);
    }
    return v;
  };
}
