/**
 * Strategy: what each player model does at a decision, as a probability for every option and every
 * hand it could hold. The same function drives the bots, narrows ranges after each action (Bayes:
 * a range keeps each hand in proportion to how often that hand takes the observed action), and gives
 * the coach its "balanced" frequencies.
 *
 * Preflop, short-stacked (the bulk of a turbo double up): the ICM all-in equilibrium from nash.ts.
 * Preflop, deeper: opening widths by seats left to act, widened by antes and tightened by ICM risk.
 * Postflop: a range-based framework. Hands are ranked by equity against the opponent's range; value
 * bets come from the top, bluffs from the bottom in the ratio the bet size makes indifferent, and the
 * defender continues with the share of range that stops bluffs from profiting (minimum defence
 * frequency, raised to its ICM form with the bubble factor). This is an approximation of a solver,
 * not a solver: the coach labels it so.
 */
import { CLASSES, COMBO_CLASS, COMBOS, NUM_CLASSES, NUM_COMBOS, rng } from './cards';
import { comboEquities, eqVsRange, fullRange, type ClassRange, type ComboRange } from './equity';
import { actingOrder, effectiveStack, legal, potTotal, type ActionKind, type Tourney } from './engine';
import { bubbleFactor } from './icm';
import { keptShare, outcomes, solveAllIn, utility, type AllInSolution, type AllInSpot } from './nash';
import { icmAwareness, mistakeRate, STYLE_IDS, styleOf, type StyleId, type StyleParams } from './styles';

export const STRATEGY = {
  /** At or below this effective stack (big blinds), unopened pots are jam or fold. */
  pushBb: 12,
  /** At or below this, the answer to an open is jam, call or fold (no small 3-bets). */
  reshoveBb: 25,
  /** Open size in big blinds: min-raise when short, a little larger deeper. */
  openBb: { short: 2, deep: 2.2, deepFromBb: 20 },
  /** Small blind first in against the big blind: widen the playing range, and limp this share of it. */
  sbVsBb: { widen: 1.25, limp: 0.5 },
  /** Re-raise to this multiple of the current bet, in and out of position. */
  reraise: { ip: 3, oop: 3.6 },
  /** Balanced open-raise share of all hands by players left to act behind the opener (index = players behind). */
  rfi: [1, 0.6, 0.45, 0.3, 0.23, 0.18, 0.15, 0.13, 0.12, 0.11],
  /** Opens widen with dead money: share *= 1 + anteWiden * (antes / blinds). */
  anteWiden: 0.35,
  /** ICM tightening for opens: share /= 1 + icmTighten * (average bubble factor - 1). */
  icmTighten: 0.5,
  /** Balanced 3-bet share of the opener's range, and the share of continuing hands that flat. */
  threeBetShare: 0.35,
  /** Equity realization: share of raw equity a hand turns into pot share before showdown. Preflop, the
   *  weakest hands lose up to `playability`; each opponent past the first multiplies by `multiway`. */
  realize: { preIp: 0.9, preOop: 0.75, postIp: 0.95, postOop: 0.85, playability: 0.3, multiway: 0.88 },
  /** Postflop bet sizes as a share of the pot. */
  sizes: { small: 0.33, big: 0.75 },
  /** Equity against the opponent's range that counts as a value hand, flop / turn / river. */
  valueEq: [0.58, 0.6, 0.64],
  /** Bluffs per value bet, multiplied onto the river's indifference ratio s/(1+s): flop / turn / river. */
  bluffMult: [1.8, 1.35, 1],
  /** Share of continuing hands that raise for value when facing a bet; bluff-raises per value raise. */
  raiseShare: 0.18,
  bluffRaise: 0.35,
  /** Width of the mixing band at range edges (share of range). */
  mixWidth: 0.04,
  /** Monte Carlo samples per combo when ranking a range on the flop or turn. */
  rankSamples: 20,
  /** Fictitious-play iterations for the all-in solver. */
  solverIterations: 70,
};

export interface Opt {
  id: string;
  kind: ActionKind;
  to?: number;
  label: string;
}

export interface Model {
  style: StyleParams;
  skill: number;
}

export const REF_MODEL: Model = { style: styleOf('gto'), skill: 5 };
export const modelOf = (style: string, skill: number): Model => ({ style: styleOf(style), skill });

/** Ranges every player is believed to hold. `model`: narrowed with each player's real style. `ref`: as if everyone were balanced. */
export interface Ranges {
  model: ComboRange[];
  ref: ComboRange[];
  /** As if each opponent played that archetype from the start of the hand (for the coach's per-style rows). */
  byStyle: Record<StyleId, ComboRange[]>;
}

const fullSet = (n: number) => Array.from({ length: n }, () => new Float64Array(NUM_COMBOS).fill(1));

export const freshRanges = (n: number): Ranges => ({
  model: fullSet(n),
  ref: fullSet(n),
  byStyle: Object.fromEntries(STYLE_IDS.map((id) => [id, fullSet(n)])) as Record<StyleId, ComboRange[]>,
});

/** Skill assumed for the per-style rows. */
export const ROW_SKILL = 4;

export const bbOf = (t: Tourney): number => t.hand!.blinds.bb;

// ---- Options

export function menu(t: Tourney): Opt[] {
  const h = t.hand!;
  const L = legal(t);
  if (!L) return [];
  const p = t.players[h.toAct]!;
  const bb = bbOf(t);
  const pot = potTotal(t);
  const out: Opt[] = [];
  const fmt = (x: number) => `${+(x / bb).toFixed(1)}bb`;
  if (!L.canCheck) out.push({ id: 'fold', kind: 'fold', label: 'Fold' });
  if (L.canCheck) out.push({ id: 'check', kind: 'check', label: 'Check' });
  else out.push({ id: 'call', kind: 'call', label: p.stack <= L.toCall ? `Call all in ${fmt(p.stack + p.bet)}` : `Call ${fmt(L.toCall)}` });
  if (L.canRaise) {
    const add = (id: string, to: number, label: string) => {
      const x = Math.round(to);
      if (x >= L.minTo && x < L.maxTo * 0.7 && !out.some((o) => o.to === x)) out.push({ id, kind: 'raise', to: x, label });
    };
    if (h.street === 0) {
      const unopened = h.currentBet <= bb;
      if (unopened) {
        const eff = effectiveStack(t, p.seat) / bb;
        const size = eff < STRATEGY.openBb.deepFromBb ? STRATEGY.openBb.short : STRATEGY.openBb.deep;
        add('raise', size * bb, `Raise ${fmt(size * bb)}`);
      } else {
        const ip = isInPosition(t, p.seat);
        const to = h.currentBet * (ip ? STRATEGY.reraise.ip : STRATEGY.reraise.oop);
        add('raise', to, `Raise ${fmt(to)}`);
      }
    } else if (L.canCheck) {
      add('small', pot * STRATEGY.sizes.small, `Bet ${fmt(pot * STRATEGY.sizes.small)}`);
      add('big', pot * STRATEGY.sizes.big, `Bet ${fmt(pot * STRATEGY.sizes.big)}`);
    } else {
      const to = h.currentBet * 3;
      add('raise', to, `Raise ${fmt(to)}`);
    }
    out.push({ id: 'allin', kind: 'allin', to: L.maxTo, label: `All in ${fmt(L.maxTo)}` });
  }
  return out;
}

/** Last to act postflop among those still in (the button side). */
export function isInPosition(t: Tourney, seat: number): boolean {
  const order = actingOrder(t, 1).filter((s) => !t.players[s]!.folded);
  return order[order.length - 1] === seat;
}

// ---- Helpers

const sig = (x: number): number => 1 / (1 + Math.exp(-x));
/** Smooth membership of a hand at range position q (0 = best) in the top `share` of the range. */
export const inTop = (q: number, share: number): number => (share <= 0 ? 0 : share >= 1 ? 1 : sig((share - q) / (STRATEGY.mixWidth / 4)));

export function classRange(r: ComboRange): ClassRange {
  const out = new Float64Array(NUM_CLASSES);
  for (let k = 0; k < NUM_COMBOS; k++) out[COMBO_CLASS[k]!]! += r[k]!;
  for (let i = 0; i < NUM_CLASSES; i++) out[i] = out[i]! / CLASSES[i]!.combos;
  return out;
}

/** Hand-class ordering for opening ranges: equity against a random hand, plus a playability edge for suited and connected hands. */
export const OPEN_SCORE: Float64Array = (() => {
  const full = fullRange();
  const s = new Float64Array(NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i++) {
    const c = CLASSES[i]!;
    const gap = c.hi - c.lo;
    s[i] = eqVsRange(i, full) + (c.suited ? 0.03 : 0) + (!c.pair && gap <= 2 ? 0.012 * (3 - gap) : 0) + (c.pair ? 0.045 : 0);
  }
  return s;
})();

/** Fill the top `share` of a prior range (by score) with frequency 1, partial at the edge. */
export function topShare(prior: ClassRange, score: ArrayLike<number>, share: number, exclude?: Float64Array): Float64Array {
  const out = new Float64Array(NUM_CLASSES);
  const avail = Array.from({ length: NUM_CLASSES }, (_, i) => i).filter((i) => prior[i]! > 0 && (exclude?.[i] ?? 0) < 1);
  const total = avail.reduce((s, i) => s + prior[i]! * CLASSES[i]!.combos * (1 - (exclude?.[i] ?? 0)), 0);
  const allTotal = Array.from({ length: NUM_CLASSES }, (_, i) => prior[i]! * CLASSES[i]!.combos).reduce((a, b) => a + b, 0);
  let left = Math.min(total, Math.max(0, share) * allTotal);
  avail.sort((a, b) => score[b]! - score[a]!);
  for (const i of avail) {
    if (left <= 0) break;
    const w = prior[i]! * CLASSES[i]!.combos * (1 - (exclude?.[i] ?? 0));
    const take = Math.min(1, left / w);
    out[i] = take * (1 - (exclude?.[i] ?? 0));
    left -= take * w;
  }
  return out;
}

/** Stretch a reference strategy by a style width multiplier, keeping the reference's hand order. */
export function widen(prior: ClassRange, ref: Float64Array, margin: ArrayLike<number>, mult: number): Float64Array {
  if (Math.abs(mult - 1) < 1e-9) return ref;
  return topShare(prior, margin, keptShare(prior, ref) * mult);
}

// ---- Preflop context

export interface PreflopSpot {
  kind: 'unopened' | 'limped' | 'raised' | 'allin';
  raisers: number[];
  limpers: number[];
  /** First voluntary all-in, if the jam came first in (so the equilibrium applies directly). */
  firstInJam: boolean;
}

export function preflopSpot(t: Tourney): PreflopSpot {
  const h = t.hand!;
  const acts = h.log.filter((a) => a.street === 0 && a.kind !== 'post');
  const raisers: number[] = [];
  const limpers: number[] = [];
  let firstInJam = false;
  for (const a of acts) {
    if (a.kind === 'raise' || (a.kind === 'allin' && a.to > h.blinds.bb)) {
      if (raisers.length === 0 && a.kind === 'allin' && limpers.length === 0) firstInJam = true;
      raisers.push(a.seat);
    } else if (a.kind === 'call' && raisers.length === 0) limpers.push(a.seat);
  }
  const me = t.players[h.toAct]!;
  const L = legal(t)!;
  const facingAllIn = raisers.length > 0 && (!L.canRaise || raisers.some((s) => t.players[s]!.allIn)) && L.toCall > 0;
  const kind = raisers.length === 0 ? (limpers.length ? 'limped' : 'unopened') : facingAllIn || me.stack <= L.toCall ? 'allin' : 'raised';
  return { kind, raisers, limpers, firstInJam: firstInJam && raisers.length === 1 };
}

/** The all-in game if `seat` jams now: everyone still able to call, in order, with their current ranges. */
export function jamSpot(t: Tourney, seat: number, ranges: ComboRange[], payouts: number[]): AllInSpot {
  const h = t.hand!;
  const n = t.players.length;
  const callers: number[] = [];
  for (let k = 1; k < n; k++) {
    const s = (seat + k) % n;
    const p = t.players[s]!;
    if (p.place === 0 && p.hole && !p.folded && (p.stack > 0 || p.bet > 0)) callers.push(s);
  }
  const contenders = callers.filter((s) => t.players[s]!.stack > 0 || t.players[s]!.bet > 0);
  const foldWinner = contenders.reduce((best, s) => (t.players[s]!.bet > t.players[best]!.bet ? s : best), contenders[0] ?? h.bbSeat);
  return {
    behind: t.players.map((p) => p.stack),
    bet: t.players.map((p) => p.bet),
    pot: potTotal(t),
    jammer: seat,
    callers: contenders,
    priors: t.players.map((_, s) => classRange(ranges[s]!)),
    payouts,
    foldWinner,
  };
}

const solveCache = new Map<string, AllInSolution>();

export function solveCached(spot: AllInSpot, icmWeight: number): AllInSolution {
  const pr = spot.priors!.map((r) => (r ? Array.from(r, (x) => x.toFixed(2)).join('') : '')).join('|');
  const key = `${icmWeight}|${spot.behind}|${spot.bet}|${spot.pot}|${spot.jammer}|${spot.callers}|${spot.foldWinner}|${hash(pr)}`;
  let s = solveCache.get(key);
  if (!s) {
    s = solveAllIn(spot, { icmWeight, iterations: STRATEGY.solverIterations });
    if (solveCache.size > 400) solveCache.clear();
    solveCache.set(key, s);
  }
  return s;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/** A player's jam (or call-a-jam) frequencies under their model: equilibrium, blended toward chip EV by ICM blindness, widened by style. */
export function modelJam(t: Tourney, spot: AllInSpot, model: Model): Float64Array {
  const prior = spot.priors![spot.jammer]!;
  const icmS = solveCached(spot, 1);
  const a = icmAwareness(model.style, model.skill);
  let base = icmS.jam;
  if (a < 0.98) {
    const chip = solveCached(spot, 0);
    base = icmS.jam.map((x, i) => a * x + (1 - a) * chip.jam[i]!);
  }
  return widen(prior, base, icmS.jamMargin, model.style.push);
}

export function modelCall(t: Tourney, spot: AllInSpot, m: number, model: Model): Float64Array {
  const prior = spot.priors![spot.callers[m]!]!;
  const icmS = solveCached(spot, 1);
  const a = icmAwareness(model.style, model.skill);
  let base = icmS.call[m]!;
  if (a < 0.98) {
    const chip = solveCached(spot, 0);
    base = base.map((x, i) => a * x + (1 - a) * chip.call[m]![i]!);
  }
  return widen(prior, base, icmS.callMargin[m]!, model.style.call);
}

export function payoutsOf(t: Tourney): number[] {
  const n = t.players.length;
  return Array.from({ length: n }, (_, i) => (i < t.config.paid ? 1 / t.config.paid : 0));
}

/** Average bubble factor of `seat` against the players still to act or in the hand. */
export function avgBubbleFactor(t: Tourney, seat: number, against: number[]): number {
  if (!against.length) return 1;
  const stacks = t.players.map((p) => (p.place === 0 ? p.stack + p.committed : 0));
  const pay = payoutsOf(t);
  return against.reduce((s, v) => s + bubbleFactor(stacks, pay, seat, v), 0) / against.length;
}

// ---- The policy

export interface Policy {
  opts: Opt[];
  /** probs[o][combo]: chance of option o with that combo (sums to 1 over options). */
  probs: Float64Array[];
  /** Short labels of the inputs used, for the coach. */
  facts: Record<string, number>;
}

/**
 * The strategy of the player to act, under `model`, given the believed ranges `ranges`
 * (the actor's own range is what they could hold; opponents' are what they are believed to hold).
 */
export function policy(t: Tourney, model: Model, ranges: ComboRange[], rand: () => number): Policy {
  const opts = menu(t);
  const probs = t.hand!.street === 0 ? preflopPolicy(t, model, ranges, opts) : postflopPolicy(t, model, ranges, opts, rand);
  // Mistakes: with probability eps the player picks an option at random.
  const eps = mistakeRate(model.skill);
  if (eps > 0 && opts.length > 1) for (const p of probs.probs) for (let k = 0; k < NUM_COMBOS; k++) p[k] = (1 - eps) * p[k]! + eps / opts.length;
  return { opts, probs: probs.probs, facts: probs.facts };
}

interface Raw {
  probs: Float64Array[];
  facts: Record<string, number>;
}

function expand(opts: Opt[], perClass: Record<string, Float64Array>): Float64Array[] {
  return opts.map((o) => {
    const c = perClass[o.id];
    const out = new Float64Array(NUM_COMBOS);
    if (c) for (let k = 0; k < NUM_COMBOS; k++) out[k] = c[COMBO_CLASS[k]!]!;
    return out;
  });
}

/** Normalise per-class option weights so each class sums to 1 (anything missing folds/checks). */
function normalise(opts: Opt[], w: Record<string, Float64Array>): Record<string, Float64Array> {
  const passive = opts.find((o) => o.id === 'fold' || o.id === 'check')!.id;
  const out: Record<string, Float64Array> = {};
  for (const o of opts) out[o.id] = new Float64Array(NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i++) {
    let s = 0;
    for (const o of opts) if (o.id !== passive) s += w[o.id]?.[i] ?? 0;
    const scale = s > 1 ? 1 / s : 1;
    let used = 0;
    for (const o of opts) {
      if (o.id === passive) continue;
      const v = (w[o.id]?.[i] ?? 0) * scale;
      out[o.id]![i] = v;
      used += v;
    }
    out[passive]![i] = Math.max(0, 1 - used);
  }
  return out;
}

function preflopPolicy(t: Tourney, model: Model, ranges: ComboRange[], opts: Opt[]): Raw {
  const h = t.hand!;
  const seat = h.toAct;
  const me = t.players[seat]!;
  const bb = bbOf(t);
  const pay = payoutsOf(t);
  const eff = effectiveStack(t, seat) / bb;
  const spot = preflopSpot(t);
  const prior = classRange(ranges[seat]!);
  const has = (id: string) => opts.some((o) => o.id === id);
  const st = model.style;
  const facts: Record<string, number> = { eff };
  const w: Record<string, Float64Array> = {};

  if (spot.kind === 'allin') {
    // Call or fold against a jam.
    const jammer = spot.raisers[spot.raisers.length - 1]!;
    // Bayes has already narrowed the jammer's range by their jam: best-respond to that range.
    // Against a balanced jammer this is the equilibrium call; against a style it is that style's exploit.
    w.call = callByEV(t, seat, jammer, ranges, model);
    return { probs: expand(opts, normalise(opts, w)), facts };
  }

  const behind = actingOrder(t, 0).filter((s) => {
    const p = t.players[s]!;
    return s !== seat && !p.folded && !p.allIn && actsAfter(t, seat, s);
  });

  if (spot.kind === 'unopened' || spot.kind === 'limped') {
    if (eff <= STRATEGY.pushBb && has('allin')) {
      w.allin = modelJam(t, jamSpot(t, seat, ranges, pay), model);
      return { probs: expand(opts, normalise(opts, w)), facts };
    }
    const anteRatio0 = (h.blinds.ante * t.players.filter((p) => p.place === 0).length) / (h.blinds.sb + h.blinds.bb);
    const bf = avgBubbleFactor(t, seat, behind);
    facts.bf = bf;
    let share = (STRATEGY.rfi[Math.min(behind.length, STRATEGY.rfi.length - 1)] ?? 0.12) * (1 + STRATEGY.anteWiden * anteRatio0);
    share /= 1 + STRATEGY.icmTighten * (bf - 1) * icmAwareness(st, model.skill);
    if (spot.kind === 'limped') share *= 0.6; // iso-raise tighter over limpers
    if (seat === h.bbSeat && spot.kind === 'unopened') share = 1;
    share = Math.min(1, share * st.open);
    const play = topShare(prior, OPEN_SCORE, share);
    const raiseId = has('raise') ? 'raise' : 'allin';
    // Small blind vs big blind alone: with antes in, solvers play a wide range and limp a large part of it.
    const sbVsBb = seat === h.sbSeat && behind.length === 1 && spot.kind === 'unopened';
    if (sbVsBb) {
      share = Math.min(1, share * STRATEGY.sbVsBb.widen);
      const playSb = topShare(prior, OPEN_SCORE, share);
      const limp = Math.max(0, Math.min(1, STRATEGY.sbVsBb.limp + st.limp * 0.5 - (st.aggression - 1) * 0.3));
      w[raiseId] = playSb.map((x) => x * (1 - limp));
      if (has('call')) w.call = playSb.map((x) => x * limp);
      return { probs: expand(opts, normalise(opts, w)), facts };
    }
    const limpShare = seat === h.bbSeat ? 0 : st.limp;
    w[raiseId] = play.map((x) => x * (1 - limpShare));
    if (limpShare > 0 && has('call')) w.call = play.map((x) => x * limpShare);
    if (seat === h.bbSeat && has('check')) {
      // big blind facing limps (or a walk): raise the top, check the rest
      w[raiseId] = topShare(prior, OPEN_SCORE, Math.min(1, 0.18 * st.threeBet * (spot.kind === 'limped' ? 1 : 0.8)));
    }
    return { probs: expand(opts, normalise(opts, w)), facts };
  }

  // Facing a raise that isn't all in.
  const raiser = spot.raisers[spot.raisers.length - 1]!;
  const rRange = classRange(ranges[raiser]!);
  const toCall = legal(t)!.toCall;
  const potAfter = potTotal(t) + toCall;
  const ip = isInPosition(t, seat) || seat === h.button;
  const R = seat === h.bbSeat || seat === h.sbSeat ? STRATEGY.realize.preOop : ip ? STRATEGY.realize.preIp : STRATEGY.realize.preOop;
  const bf = avgBubbleFactor(t, seat, [raiser]);
  facts.bf = bf;
  const icmA = icmAwareness(st, model.skill);
  const riskShare = Math.min(1, toCall / Math.max(1, me.stack + me.bet));
  const need = (toCall / potAfter) * (1 + (bf - 1) * icmA * Math.max(0.35, riskShare));
  facts.need = need;
  const eqs = new Float64Array(NUM_CLASSES).map((_, i) => eqVsRange(i, rRange));
  let jam: Float64Array = new Float64Array(NUM_CLASSES);
  if (has('allin') && (eff <= STRATEGY.reshoveBb || spot.raisers.length >= 2)) {
    jam = modelJam(t, jamSpot(t, seat, ranges, pay), { ...model, style: { ...st, push: st.threeBet } });
    w.allin = jam;
  } else if (has('raise')) {
    const share = STRATEGY.threeBetShare * keptShare(fullRange(), rRange) * st.threeBet;
    w.raise = topShare(prior, eqs, share);
    jam = w.raise;
  }
  // Flat calls: hands not re-raising whose realized equity beats the ICM-adjusted price.
  const callScore = eqs.map((e) => e * R - need);
  const callers = new Float64Array(NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i++) if (callScore[i]! > 0) callers[i] = 1 - jam[i]!;
  const callShare = keptShare(prior, callers) * st.call;
  w.call = topShare(prior, callScore, callShare, jam);
  return { probs: expand(opts, normalise(opts, w)), facts };
}

function actsAfter(t: Tourney, seat: number, other: number): boolean {
  const order = actingOrder(t, t.hand!.street);
  return order.indexOf(other) > order.indexOf(seat);
}

/** Call a non-first-in jam when the ICM EV of calling beats folding against the jammer's range (heads-up approximation). */
function callByEV(t: Tourney, seat: number, jammer: number, ranges: ComboRange[], model: Model): Float64Array {
  const spot = jamSpot(t, jammer, ranges, payoutsOf(t));
  const solo: AllInSpot = { ...spot, callers: [seat] };
  const a = icmAwareness(model.style, model.skill);
  const jr = classRange(ranges[jammer]!);
  const others = overcallers(t, seat, jammer).map((s) => classRange(ranges[s]!));
  const margin = new Float64Array(NUM_CLASSES).map((_, j) => callMarginVsRange(solo, j, jr, a, others));
  const best = margin.map((x) => (x > 0 ? 1 : 0));
  return widen(classRange(ranges[seat]!), best, margin, model.style.call);
}

/** Players who already called the jam (the hero would be in a multiway all-in). */
export function overcallers(t: Tourney, seat: number, jammer: number): number[] {
  const log = t.hand!.log;
  const at = log.findIndex((a) => a.seat === jammer && a.kind === 'allin' && a.street === 0);
  const out = new Set<number>();
  for (const a of log.slice(at + 1)) if (a.seat !== seat && a.seat !== jammer && (a.kind === 'call' || a.kind === 'allin')) out.add(a.seat);
  return [...out].filter((s) => !t.players[s]!.folded);
}

/**
 * ICM EV of calling a jam minus folding, for class j. With players already in (`others`), the chance
 * of beating everyone is taken as the product of the heads-up equities (an independence approximation).
 */
export function callMarginVsRange(spot: AllInSpot, j: number, jamRange: ClassRange, icmWeight: number, others: ClassRange[] = []): number {
  const U = utility(spot.payouts, icmWeight);
  const o = outcomes(spot);
  const c = spot.callers[0]!;
  const e = others.reduce((acc, r) => acc * eqVsRange(j, r), eqVsRange(j, jamRange));
  const v = o.vs[0]!;
  return e * U(v.cw)[c]! + (1 - e) * U(v.pw)[c]! - U(o.steal)[c]!;
}

// ---- Postflop

/** The opponent whose range the actor plays against: the last bettor this street, else the next player in. */
export function mainVillain(t: Tourney, seat: number): number {
  const h = t.hand!;
  const bets = h.log.filter((a) => a.street === h.street && (a.kind === 'raise' || a.kind === 'allin') && a.seat !== seat);
  if (bets.length) return bets[bets.length - 1]!.seat;
  const prevAgg = h.log.filter((a) => (a.kind === 'raise' || a.kind === 'allin') && a.seat !== seat);
  const live = t.players.filter((p) => p.place === 0 && p.hole && !p.folded && p.seat !== seat);
  const last = prevAgg.length ? prevAgg[prevAgg.length - 1]!.seat : -1;
  if (live.some((p) => p.seat === last)) return last;
  return live[0]?.seat ?? seat;
}

/** Range position of every combo in `mine` (0 = strongest), by equity against `opp`. */
const rankCache = new Map<string, { q: Float64Array; eq: Float64Array }>();
const rangeKey = (r: ComboRange): number => {
  let a = 0;
  let b = 0;
  for (let k = 0; k < NUM_COMBOS; k++) {
    const x = r[k]!;
    a += x * ((k * 2654435761) % 1000003);
    b += x;
  }
  return a * 1e-3 + b;
};

export function rangePositions(mine: ComboRange, board: number[], opp: ComboRange, rand: () => number): { q: Float64Array; eq: Float64Array } {
  const key = `${board}|${rangeKey(mine)}|${rangeKey(opp)}`;
  const hit = rankCache.get(key);
  if (hit) return hit;
  // Seeded from the inputs, not the caller's stream: the result is a pure function of the spot, so a
  // cached ranking (perhaps first computed by the coach) never changes what a bot does on replay.
  void rand;
  const res = rankRange(mine, board, opp, rng(hash(key)));
  if (rankCache.size > 300) rankCache.clear();
  rankCache.set(key, res);
  return res;
}

function rankRange(mine: ComboRange, board: number[], opp: ComboRange, rand: () => number): { q: Float64Array; eq: Float64Array } {
  const eq = comboEquities(mine, board, opp, rand, STRATEGY.rankSamples);
  const idx: number[] = [];
  const dead = new Set(board);
  const live = new Float64Array(NUM_COMBOS);
  for (let k = 0; k < NUM_COMBOS; k++) {
    const w = mine[k]!;
    if (w <= 0) continue;
    const c = comboCards(k);
    if (dead.has(c[0]) || dead.has(c[1])) continue;
    live[k] = w;
    idx.push(k);
  }
  idx.sort((a, b) => eq[b]! - eq[a]!);
  const total = idx.reduce((s, k) => s + live[k]!, 0);
  const q = new Float64Array(NUM_COMBOS).fill(1);
  let acc = 0;
  for (const k of idx) {
    q[k] = total > 0 ? (acc + live[k]! / 2) / total : 0.5;
    acc += live[k]!;
  }
  return { q, eq };
}

const comboCards = (k: number): [number, number] => COMBOS[k]!;

function postflopPolicy(t: Tourney, model: Model, ranges: ComboRange[], opts: Opt[], rand: () => number): Raw {
  const h = t.hand!;
  const seat = h.toAct;
  const me = t.players[seat]!;
  const st = model.style;
  const villain = mainVillain(t, seat);
  const { q, eq } = rangePositions(ranges[seat]!, h.board, ranges[villain]!, rand);
  const street = h.street; // 1..3
  const L = legal(t)!;
  const pot = potTotal(t);
  const has = (id: string) => opts.some((o) => o.id === id);
  const out = opts.map(() => new Float64Array(NUM_COMBOS));
  const at = (id: string) => opts.findIndex((o) => o.id === id);
  const facts: Record<string, number> = {};
  // Value share: the part of my range that is ahead of the villain's range by the street's margin.
  let vShare = 0;
  let tot = 0;
  for (let k = 0; k < NUM_COMBOS; k++) {
    const w = ranges[seat]![k]!;
    if (w <= 0 || q[k]! >= 1) continue;
    tot += w;
    if (eq[k]! >= STRATEGY.valueEq[street - 1]!) vShare += w;
  }
  vShare = tot > 0 ? vShare / tot : 0;
  facts.valueShare = vShare;
  const bfV = avgBubbleFactor(t, seat, [villain]);
  facts.bf = bfV;
  const icmA = icmAwareness(st, model.skill);
  const bf = 1 + (bfV - 1) * icmA;

  if (L.canCheck) {
    const sizeId = street === 1 ? 'small' : 'big';
    const size = street === 1 ? STRATEGY.sizes.small : STRATEGY.sizes.big;
    const betId = has(sizeId) ? sizeId : has('small') ? 'small' : has('allin') ? 'allin' : '';
    const sizeFrac = betId === 'allin' ? me.stack / Math.max(1, pot) : size;
    const valueBet = Math.min(0.95, vShare * Math.min(1.35, st.aggression));
    const ratio = (sizeFrac / (1 + sizeFrac)) * STRATEGY.bluffMult[street - 1]! * st.bluff / bf;
    const bluffs = Math.min(0.5, valueBet * ratio);
    facts.betShare = valueBet + bluffs;
    const pBetValue = Math.min(1, st.aggression);
    const iB = betId ? at(betId) : -1;
    const iC = at('check');
    for (let k = 0; k < NUM_COMBOS; k++) {
      if (ranges[seat]![k]! <= 0) continue;
      let b = 0;
      if (iB >= 0) b = Math.min(1, pBetValue * inTop(q[k]!, valueBet) + inTop(1 - q[k]!, bluffs));
      // Very strong hands with little behind just get it in.
      if (iB >= 0 && has('allin') && me.stack <= pot * 1.2 && eq[k]! > 0.7) {
        out[at('allin')]![k] = b;
      } else if (iB >= 0) out[iB]![k] = b;
      out[iC]![k] = 1 - b;
    }
    return { probs: out, facts };
  }

  // Facing a bet.
  const bet = L.toCall;
  const potBefore = pot - bet;
  const defend = Math.min(0.97, Math.max(0.03, (potBefore / (potBefore + bet * bf)) * st.call));
  facts.defend = defend;
  const raiseId = has('raise') ? 'raise' : has('allin') ? 'allin' : '';
  const rv = Math.min(defend, defend * STRATEGY.raiseShare * st.aggression);
  const rb = rv * STRATEGY.bluffRaise * st.bluff;
  const iF = at('fold');
  const iCall = at('call');
  const iR = raiseId ? at(raiseId) : -1;
  for (let k = 0; k < NUM_COMBOS; k++) {
    if (ranges[seat]![k]! <= 0) continue;
    const d = inTop(q[k]!, defend);
    let r = 0;
    if (iR >= 0) r = Math.min(d, inTop(q[k]!, rv)) + Math.max(0, inTop(q[k]!, defend + rb) - d);
    const c = Math.max(0, d - Math.min(d, iR >= 0 ? inTop(q[k]!, rv) : 0));
    if (iR >= 0) out[iR]![k] = r;
    out[iCall]![k] = c;
    out[iF]![k] = Math.max(0, 1 - r - c);
  }
  return { probs: out, facts };
}

// ---- Range narrowing

/** After `seat` takes option `optId`, keep each hand in proportion to how often it takes that option. */
export function narrow(range: ComboRange, pol: Policy, optId: string): void {
  const o = pol.opts.findIndex((x) => x.id === optId);
  if (o < 0) return;
  const p = pol.probs[o]!;
  let s = 0;
  for (let k = 0; k < NUM_COMBOS; k++) {
    range[k] = range[k]! * p[k]!;
    s += range[k]!;
  }
  // An action the model thinks this range never takes (a mistake): keep the old range rather than empty it.
  if (s <= 1e-9) for (let k = 0; k < NUM_COMBOS; k++) range[k] = range[k]! > 0 || p[k]! > 0 ? 1 : 0;
}

/** Which option an engine action corresponds to (for narrowing after a bot or hero acts). */
export function optFor(opts: Opt[], kind: ActionKind, to: number | undefined): string {
  if (kind === 'fold' || kind === 'check' || kind === 'call') return opts.find((o) => o.kind === kind)?.id ?? kind;
  if (kind === 'allin') return opts.find((o) => o.kind === 'allin')?.id ?? 'allin';
  let best = opts.find((o) => o.kind === 'raise')?.id ?? 'allin';
  let d = Infinity;
  for (const o of opts) if (o.kind === 'raise' && o.to !== undefined && Math.abs(o.to - (to ?? 0)) < d) {
    d = Math.abs(o.to - (to ?? 0));
    best = o.id;
  }
  return best;
}
