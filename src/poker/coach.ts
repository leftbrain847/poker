/**
 * The coach, for the hero's decision:
 *   - Balanced strategy: how an equilibrium player plays this exact hand here (frequencies).
 *   - Exploit: every option's ICM EV against the table as it really is (each seat's style and skill);
 *     the best of these is the maximally exploitative play.
 *   - By type: the best option and EV gaps if the opponents were each archetype instead.
 *
 * EV method. Short-stack preflop jams and calls: the exact ICM all-in game (nash.ts), with each
 * opponent's calling strategy from their model. Everything else: one level of look-ahead. Each
 * opponent still to act answers the hero's option with their policy (fold / call / raise shares over
 * the range they are believed to hold, given what the hero's action says about the hero's range); the
 * hero then best-responds once. Pots still contested when the betting round ends are valued at the
 * hero's equity against the continuing ranges, times a realization factor if streets remain. Every
 * outcome is scored as the ICM value of the resulting stacks, in buy-ins.
 */
import { COMBO_CLASS, NUM_COMBOS, type Card } from './cards';
import { equityVsRanges, eqVsRange, type ComboRange } from './equity';
import { act, actingOrder, alive, effectiveStack, legal, potTotal, type Tourney } from './engine';
import { comboOf, decisionRand, type Game } from './game';
import { bubbleFactor, icm, icmRequiredEquity } from './icm';
import { jammerEV, utility } from './nash';
import {
  bbOf,
  callMarginVsRange,
  classRange,
  isInPosition,
  jamSpot,
  mainVillain,
  modelCall,
  modelOf,
  OPEN_SCORE,
  overcallers,
  payoutsOf,
  policy,
  preflopSpot,
  REF_MODEL,
  ROW_SKILL,
  STRATEGY,
  topShare,
  type Model,
  type Opt,
  type Policy,
} from './strategy';
import { STYLE_IDS, STYLES, styleOf, type StyleId } from './styles';

export interface OptionAdvice {
  opt: Opt;
  /** Balanced strategy's frequency for this exact hand (0..1). */
  gto: number;
  /** EV against the actual table, in buy-ins. */
  ev: number;
}

export interface StyleRow {
  style: StyleId;
  /** EV per option (same order as `options`), in buy-ins. */
  ev: number[];
  best: number;
}

export interface Spot {
  position: string;
  street: number;
  stackBb: number;
  effBb: number;
  m: number;
  left: number;
  paid: number;
  bubble: boolean;
  potBb: number;
  toCallBb: number;
  /** Raw pot odds: call / (pot + call). */
  potOdds: number;
  villain: number;
  /** Bubble factor against the main villain. */
  bf: number;
  /** Equity needed to call under ICM (risk scaled by the bubble factor). */
  needIcm: number;
  /** Hero's equity against the main villain's range: balanced read, and their real style's. */
  eqRef: number;
  eqTable: number;
  /** Which model produced the balanced frequencies. */
  method: 'equilibrium' | 'framework';
  /** Facing a raise or bet (not just the big blind), so pot odds mean something. */
  facingBet: boolean;
}

export interface Analysis {
  options: OptionAdvice[];
  /** Option the balanced strategy plays most with this hand, and the best EV against the table. */
  gtoPlay: number;
  best: number;
  /** EV of the balanced mix against the table: what following the balanced strategy is worth here. */
  evGtoMix: number;
  rows: StyleRow[];
  spot: Spot;
  notes: string[];
}

interface View {
  ranges: ComboRange[];
  model: (seat: number) => Model;
}

const POS_BACK = ['BTN', 'CO', 'HJ', 'LJ', 'UTG+2', 'UTG+1', 'UTG'];

export function positionName(t: Tourney, seat: number): string {
  const h = t.hand!;
  if (seat === h.sbSeat && seat === h.button) return 'BTN/SB';
  if (seat === h.sbSeat) return 'SB';
  if (seat === h.bbSeat) return 'BB';
  const order = actingOrder(t, 0).filter((s) => s !== h.sbSeat && s !== h.bbSeat);
  return POS_BACK[order.length - 1 - order.indexOf(seat)] ?? 'UTG';
}

const buyIns = (t: Tourney, share: number): number => share * t.players.length;
const stacksNow = (t: Tourney): number[] => t.players.map((p) => (p.place === 0 ? p.stack : 0));
const U = (t: Tourney, stacks: number[], hero: number): number => icm(stacks, payoutsOf(t))[hero]!;
const liveOthers = (t: Tourney, hero: number) => t.players.filter((p) => p.place === 0 && p.hole && !p.folded && p.seat !== hero);

/** Stacks if `winner` takes the whole pot now. */
function award(t: Tourney, winner: number): number[] {
  const s = stacksNow(t);
  s[winner]! += potTotal(t);
  return s;
}

/** The opponent who takes the pot when the hero loses it: the one with the most chips in. */
function taker(t: Tourney, hero: number): number {
  const live = liveOthers(t, hero);
  return live.reduce((b, p) => (p.committed > t.players[b]!.committed ? p.seat : b), live[0]?.seat ?? hero);
}

const classOfHole = (hole: [Card, Card]): number => COMBO_CLASS[comboOf(hole)]!;

function heroEquity(t: Tourney, hole: [Card, Card], ranges: ComboRange[], rand: () => number): number {
  if (!ranges.length) return 1;
  const board = t.hand!.board;
  if (board.length === 0 && ranges.length === 1) return eqVsRange(classOfHole(hole), classRange(ranges[0]!));
  return equityVsRanges(hole, board, ranges, rand, 700);
}

/**
 * Value of a pot still contested when the look-ahead stops: the hero wins it with probability
 * equity x realization (1 at a showdown), else the main opponent takes it.
 */
function lottery(t: Tourney, hero: number, eq: number, showdown: boolean): number {
  const e = Math.min(1, eq * (showdown ? 1 : realization(t, hero)));
  return e * U(t, award(t, hero), hero) + (1 - e) * U(t, award(t, taker(t, hero)), hero);
}

/** Hand-class percentile by opening strength (1 = best), for preflop realization. */
const PLAY_PCT = (() => {
  const idx = Array.from({ length: 169 }, (_, i) => i).sort((a, b) => OPEN_SCORE[a]! - OPEN_SCORE[b]!);
  const out = new Float64Array(169);
  idx.forEach((c, r) => (out[c] = r / 168));
  return out;
})();

/**
 * Share of raw equity a hand turns into pot share when streets remain: by position, lower for hands
 * that play badly postflop (preflop), and lower again for each extra opponent.
 */
function realization(t: Tourney, hero: number): number {
  const h = t.hand!;
  const ip = isInPosition(t, hero);
  const R = STRATEGY.realize;
  let r = h.street === 0 ? (ip ? R.preIp : R.preOop) : ip ? R.postIp : R.postOop;
  if (h.street === 0) r -= R.playability * (1 - PLAY_PCT[classOfHole(t.players[hero]!.hole!)]!);
  const opps = liveOthers(t, hero).length;
  return Math.max(0.3, r * Math.pow(R.multiway, Math.max(0, opps - 1)));
}

/** No more betting possible: someone is all in and at most one player can still bet. */
const noMoreBetting = (t: Tourney): boolean => t.players.filter((p) => p.place === 0 && p.hole && !p.folded && !p.allIn).length <= 1;

function shareOf(range: ComboRange, probs: Float64Array): number {
  let s = 0;
  let w = 0;
  for (let k = 0; k < NUM_COMBOS; k++) {
    const r = range[k]!;
    if (r <= 0) continue;
    w += r;
    s += r * probs[k]!;
  }
  return w > 0 ? s / w : 0;
}

function lookaheadCopy(t: Tourney): Tourney {
  const c = structuredClone(t);
  c.lookahead = true;
  return c;
}

/** EV of one hero option under a view. `heroRange` is the hero's range as read after taking it. */
function evOption(g: Game, opt: Opt, view: View, heroRange: ComboRange, rand: () => number): number {
  const t0 = g.t;
  const hero = g.hero;
  const hole = t0.players[hero]!.hole!;
  const h0 = t0.hand!;
  if (opt.kind === 'fold') return U(t0, award(t0, taker(t0, hero)), hero);
  const ranges = view.ranges.map((r, s) => (s === hero ? g.ranges.ref[hero]! : r));
  const eff = effectiveStack(t0, hero) / bbOf(t0);
  // Short-stack jam: the exact all-in game, with each opponent calling as their model does.
  if (h0.street === 0 && opt.kind === 'allin' && eff <= STRATEGY.reshoveBb) {
    const spot = jamSpot(t0, hero, ranges, payoutsOf(t0));
    if (spot.callers.length) {
      const calls = spot.callers.map((c, m) => modelCall(t0, spot, m, view.model(c)));
      return jammerEV(spot, utility(spot.payouts, 1), calls, classOfHole(hole)).jam;
    }
  }
  // Calling a jam preflop: exact ICM against the jammer's range.
  if (h0.street === 0 && opt.kind === 'call' && preflopSpot(t0).kind === 'allin') {
    const jammer = preflopSpot(t0).raisers.slice(-1)[0]!;
    const spot = { ...jamSpot(t0, jammer, ranges, payoutsOf(t0)), callers: [hero] };
    const others = overcallers(t0, hero, jammer).map((x) => classRange(ranges[x]!));
    return U(t0, award(t0, jammer), hero) + callMarginVsRange(spot, classOfHole(hole), classRange(ranges[jammer]!), 1, others);
  }

  const seen = view.ranges.map((r, s) => (s === hero ? heroRange : r));
  const t = lookaheadCopy(t0);
  act(t, { kind: opt.kind, to: opt.to });
  let reach = 1;
  let ev = 0;
  let guard = 0;
  while (!t.hand!.frozen && t.hand!.toAct >= 0 && t.hand!.toAct !== hero && guard++ < 12) {
    const seat = t.hand!.toAct;
    const pol = policy(t, view.model(seat), seen, rand);
    const range = view.ranges[seat]!;
    const iPass = pol.opts.findIndex((o) => o.kind === 'fold' || o.kind === 'check');
    for (let o = 0; o < pol.opts.length; o++) {
      if (o === iPass) continue;
      const p = shareOf(range, pol.probs[o]!);
      if (p <= 1e-4) continue;
      const cont = new Float64Array(NUM_COMBOS);
      for (let k = 0; k < NUM_COMBOS; k++) cont[k] = range[k]! * pol.probs[o]![k]!;
      const tc = structuredClone(t);
      act(tc, { kind: pol.opts[o]!.kind, to: pol.opts[o]!.to });
      ev += reach * p * heroAfter(tc, hero, hole, seat, cont, view, rand);
    }
    reach *= iPass >= 0 ? shareOf(range, pol.probs[iPass]!) : 0;
    if (reach <= 1e-6) return ev;
    act(t, { kind: pol.opts[iPass]!.kind });
  }
  if (liveOthers(t, hero).length === 0) return ev + reach * U(t, award(t, hero), hero);
  const opp = liveOthers(t, hero).map((p) => view.ranges[p.seat]!);
  const showdown = noMoreBetting(t) || (t.hand!.frozen === true && h0.street === 3);
  return ev + reach * lottery(t, hero, heroEquity(t, hole, opp, rand), showdown);
}

/** After an opponent continues: if the hero faces more chips, the better of folding and calling; else the pot as a lottery. */
function heroAfter(t: Tourney, hero: number, hole: [Card, Card], villain: number, vRange: ComboRange, view: View, rand: () => number): number {
  const opp = (tt: Tourney) => liveOthers(tt, hero).map((p) => (p.seat === villain ? vRange : view.ranges[p.seat]!));
  const street = t.hand!.street;
  if (!t.hand!.frozen && t.hand!.toAct === hero) {
    const L = legal(t)!;
    if (L.toCall > 0) {
      const foldV = U(t, award(t, villain), hero);
      const tc = structuredClone(t);
      act(tc, { kind: 'call' });
      const showdown = noMoreBetting(tc) || street === 3;
      const callV = lottery(tc, hero, heroEquity(tc, hole, opp(tc), rand), showdown);
      return Math.max(foldV, callV);
    }
  }
  return lottery(t, hero, heroEquity(t, hole, opp(t), rand), noMoreBetting(t) || (street === 3 && t.hand!.frozen === true));
}

/** The hero's range as the table reads it after each option (balanced strategy, without random mistakes). */
function rangesAfter(g: Game, pol: Policy): ComboRange[] {
  const prior = g.ranges.ref[g.hero]!;
  const eps = 0.01 / pol.opts.length;
  return pol.opts.map((o, i) => {
    const r = new Float64Array(NUM_COMBOS);
    let s = 0;
    let s0 = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      r[k] = prior[k]! * Math.max(0, (pol.probs[i]![k]! - eps) / 0.99);
      s += r[k]!;
      s0 += prior[k]!;
    }
    // An option the balanced strategy never takes here: an unexpected jam reads as strong, anything else as unchanged.
    if (s < s0 * 0.003) {
      if (o.kind === 'allin' && g.t.hand!.street === 0) {
        const top = topShare(classRange(prior), OPEN_SCORE, 0.03);
        for (let k = 0; k < NUM_COMBOS; k++) r[k] = prior[k]! * top[COMBO_CLASS[k]!]!;
      } else r.set(prior);
    }
    return r;
  });
}

export function analyse(g: Game): Analysis {
  const t = g.t;
  const h = t.hand!;
  const hero = g.hero;
  const me = t.players[hero]!;
  const bb = bbOf(t);
  const combo = comboOf(me.hole!);

  const gtoPol = policy(t, REF_MODEL, g.ranges.ref, decisionRand(g, 1));
  const opts = gtoPol.opts;
  const eps = 0.01 / opts.length;
  const raw = opts.map((_, o) => Math.max(0, (gtoPol.probs[o]![combo]! - eps) / 0.99));
  const fs = raw.reduce((a, b) => a + b, 0) || 1;
  const gto = raw.map((x) => x / fs);
  const after = rangesAfter(g, gtoPol);

  const tableView: View = { ranges: g.ranges.model, model: (s) => modelOf(t.players[s]!.style, t.players[s]!.skill) };
  const ev = opts.map((o, i) => buyIns(t, evOption(g, o, tableView, after[i]!, decisionRand(g, 12))));
  const rows: StyleRow[] = STYLE_IDS.map((sid) => {
    const v: View = { ranges: g.ranges.byStyle[sid], model: () => (sid === 'gto' ? REF_MODEL : modelOf(sid, ROW_SKILL)) };
    const e = opts.map((o, i) => buyIns(t, evOption(g, o, v, after[i]!, decisionRand(g, 13))));
    return { style: sid, ev: e, best: argmax(e) };
  });

  const L = legal(t)!;
  const villain = mainVillain(t, hero);
  const stacks = t.players.map((p) => (p.place === 0 ? p.stack + p.committed : 0));
  const bf = villain !== hero ? bubbleFactor(stacks, payoutsOf(t), hero, villain) : 1;
  const pot = potTotal(t);
  const lv = h.blinds;
  const nAlive = alive(t).length;
  const pre = h.street === 0;
  const rand = decisionRand(g, 7);
  const effBb = effectiveStack(t, hero) / bb;
  const pf = pre ? preflopSpot(t) : null;
  // Facing a jam that others already called: equity is against everyone in.
  const extra = pf?.kind === 'allin' ? overcallers(t, hero, villain) : [];
  const eqOf = (rs: ComboRange[]) =>
    villain === hero
      ? 1
      : pre
        ? [rs[villain]!, ...extra.map((x) => rs[x]!)].reduce((acc, r) => acc * eqVsRange(COMBO_CLASS[combo]!, classRange(r)), 1)
        : equityVsRanges(me.hole!, h.board, [rs[villain]!], rand, 1200);
  const spot: Spot = {
    position: positionName(t, hero),
    street: h.street,
    stackBb: (me.stack + me.bet) / bb,
    effBb,
    m: (me.stack + me.committed) / (lv.sb + lv.bb + lv.ante * nAlive),
    left: nAlive,
    paid: t.config.paid,
    bubble: nAlive === t.config.paid + 1,
    potBb: pot / bb,
    toCallBb: L.toCall / bb,
    potOdds: L.toCall > 0 ? L.toCall / (pot + L.toCall) : 0,
    villain,
    bf,
    needIcm: L.toCall > 0 ? icmRequiredEquity(L.toCall, pot, bf) : 0,
    eqRef: eqOf(g.ranges.ref),
    eqTable: eqOf(g.ranges.model),
    facingBet: L.toCall > 0 && (!pf || pf.kind === 'raised' || pf.kind === 'allin'),
    method:
      pf && (pf.kind === 'allin' || (effBb <= STRATEGY.pushBb && pf.kind !== 'raised') || (effBb <= STRATEGY.reshoveBb && pf.kind === 'raised'))
        ? 'equilibrium'
        : 'framework',
  };
  const options: OptionAdvice[] = opts.map((opt, o) => ({ opt, gto: gto[o]!, ev: ev[o]! }));
  const best = argmax(ev);
  const evGtoMix = options.reduce((s, o) => s + o.gto * o.ev, 0);
  const a: Analysis = { options, gtoPlay: argmax(gto), best, evGtoMix, rows, spot, notes: [] };
  a.notes = explain(t, g, a);
  return a;
}

const argmax = (xs: number[]): number => xs.reduce((b, x, i) => (x > xs[b]! ? i : b), 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

function explain(t: Tourney, g: Game, a: Analysis): string[] {
  const s = a.spot;
  const out: string[] = [];
  const v = t.players[s.villain]!;
  const vs = styleOf(v.style);
  const hasVillain = s.villain !== g.hero;
  if (s.bubble) out.push(`Bubble: ${s.left} left, ${s.paid} paid. Against ${v.name} each chip lost is worth ${s.bf.toFixed(1)}x a chip won.`);
  else if (hasVillain && s.bf > 1.1) out.push(`ICM: bubble factor ${s.bf.toFixed(2)} against ${v.name}: losing a chip costs ${s.bf.toFixed(1)}x what winning one gains.`);
  if (s.facingBet) out.push(`Price: pot odds ${pct(s.potOdds)}; with ICM you need ${pct(s.needIcm)}. You have ${pct(s.eqRef)} against a balanced range, ${pct(s.eqTable)} against ${v.name}'s.`);
  if (s.method === 'equilibrium' && s.toCallBb > 0 && s.street === 0 && a.options.some((o) => o.opt.kind === 'call') && !a.options.some((o) => o.opt.kind === 'raise') && s.toCallBb * 1 >= s.effBb * 0.9 - 0.01) out.push('Facing a jam: call or fold by exact ICM EV against the jamming range.');
  else if (s.method === 'equilibrium') out.push(`${s.effBb.toFixed(1)}bb, M ${s.m.toFixed(1)}: an all-in spot, so the balanced play is the ICM push/fold equilibrium.`);
  else if (s.street === 0) out.push('Deeper stacks: opening widths by seats behind, widened by antes, tightened by ICM (approximation).');
  else out.push('Postflop: range framework (value-to-bluff ratio from bet size, ICM-adjusted defence). Approximates a solver.');
  if (hasVillain) {
    const best = a.options[a.best]!;
    const gain = best.ev - a.evGtoMix;
    if (a.best !== a.gtoPlay && gain > 0.002) out.push(`Exploit ${v.name} (${vs.short}): ${best.opt.label} gains ${(gain * 100).toFixed(1)}% of a buy-in over the balanced play. ${vs.leak}`);
    else out.push(`Against ${v.name} (${vs.short}) the balanced play is also the best exploit.`);
  }
  return out;
}

/** EV lost by an option compared with the best against the table, in buy-ins, and the balanced frequency. */
export function grade(a: Analysis, optId: string): { loss: number; gtoFreq: number; bestLabel: string } {
  const o = a.options.find((x) => x.opt.id === optId) ?? a.options[0]!;
  return { loss: a.options[a.best]!.ev - o.ev, gtoFreq: o.gto, bestLabel: a.options[a.best]!.opt.label };
}

export const styleName = (id: StyleId): string => STYLES[id].short;
