import { describe, expect, it } from 'vitest';
import { classByName, CLASSES, parseCard } from '../src/poker/cards';
import { analyse } from '../src/poker/coach';
import { eqVsRange, fullRange } from '../src/poker/equity';

import { apply, newGame, nextHand, type Game } from '../src/poker/game';
import { keptShare, solveAllIn } from '../src/poker/nash';
import { callMarginVsRange, classRange, jamSpot, modelJam, modelOf, payoutsOf } from '../src/poker/strategy';
import type { StyleId } from '../src/poker/styles';

const full = fullRange();
const CFG = { startStack: 1500, handsPerLevel: 6, paid: 3, levels: [{ sb: 100, bb: 200, ante: 25 }] };

/** A 6-handed game where seat `jammer` (first to act) has just moved all in and the hero must respond. */
function facingJam(style: StyleId, hole: string): Game {
  for (let seed = 1; seed < 200; seed++) {
    const seats = [{ name: 'You', style: 'gto', skill: 5, hero: true }, ...[1, 2, 3, 4, 5].map((i) => ({ name: `B${i}`, style, skill: 4 }))];
    const g = newGame(CFG, seats, seed);
    nextHand(g);
    const h = g.t.hand!;
    if (h.toAct === 0 || h.bbSeat !== 0) continue; // want the hero in the big blind, facing a first-in jam
    apply(g, { kind: 'allin' });
    while (g.t.hand!.toAct !== 0 && g.t.hand!.toAct >= 0) apply(g, { kind: 'fold' });
    if (g.t.hand!.toAct !== 0) continue;
    g.t.players[0]!.hole = [parseCard(hole.slice(0, 2)), parseCard(hole.slice(2, 4))];
    return g;
  }
  throw new Error('no seed put the hero in the big blind');
}

describe('push/fold equilibrium', () => {
  it('heads-up 10bb chip EV matches the published Nash ranges (about 58% push, 37% call)', () => {
    const s = solveAllIn({ behind: [9.5, 9], bet: [0.5, 1], pot: 1.5, jammer: 0, callers: [1], payouts: [1, 0], foldWinner: 1 }, { icmWeight: 0, iterations: 200 });
    expect(keptShare(full, s.jam)).toBeGreaterThan(0.55);
    expect(keptShare(full, s.jam)).toBeLessThan(0.61);
    expect(keptShare(full, s.call[0]!)).toBeGreaterThan(0.34);
    expect(keptShare(full, s.call[0]!)).toBeLessThan(0.4);
  });
  it('ICM in a double up makes callers far tighter than chip EV', () => {
    const behind = [9.875, 9.875, 9.875, 9.875, 9.375, 8.875];
    const spot = { behind, bet: [0, 0, 0, 0, 0.5, 1], pot: 6 * 0.125 + 1.5, jammer: 0, callers: [1, 2, 3, 4, 5], payouts: [1 / 3, 1 / 3, 1 / 3, 0, 0, 0], foldWinner: 5 };
    const icm = solveAllIn(spot, { icmWeight: 1, iterations: 80 });
    const chip = solveAllIn(spot, { icmWeight: 0, iterations: 80 });
    expect(keptShare(full, icm.call[4]!)).toBeLessThan(keptShare(full, chip.call[4]!) * 0.6);
  }, 30000);
});

describe('player models', () => {
  it('a maniac jams much wider than a nit from the same spot', () => {
    const g = newGame(CFG, [0, 1, 2, 3, 4, 5].map((i) => ({ name: `P${i}`, style: 'gto', skill: 4, hero: i === 0 })), 3);
    nextHand(g);
    const seat = g.t.hand!.toAct;
    const spot = jamSpot(g.t, seat, g.ranges.ref, payoutsOf(g.t));
    const nit = keptShare(full, modelJam(g.t, spot, modelOf('nit', 4)));
    const man = keptShare(full, modelJam(g.t, spot, modelOf('maniac', 4)));
    expect(man).toBeGreaterThan(nit * 2);
  }, 30000);
  it('Bayes: a nit who jams holds a stronger range than a maniac who jams', () => {
    const avgEq = (g: Game, seat: number) => {
      const r = classRange(g.ranges.model[seat]!);
      let w = 0;
      let e = 0;
      for (let i = 0; i < 169; i++) {
        const c = r[i]! * CLASSES[i]!.combos;
        w += c;
        e += c * eqVsRange(i, full);
      }
      return e / w;
    };
    const nit = facingJam('nit', 'AhAd');
    const man = facingJam('maniac', 'AhAd');
    const jn = nit.t.hand!.log.find((a) => a.kind === 'allin')!.seat;
    const jm = man.t.hand!.log.find((a) => a.kind === 'allin')!.seat;
    expect(avgEq(nit, jn)).toBeGreaterThan(avgEq(man, jm) + 0.03);
  }, 60000);
  it('a call already in the pot makes calling a jam worse (multiway equity)', () => {
    const g = facingJam('gto', 'AhTd');
    const jammer = g.t.hand!.log.find((a) => a.kind === 'allin')!.seat;
    const spot = { ...jamSpot(g.t, jammer, g.ranges.ref, payoutsOf(g.t)), callers: [0] };
    const jr = classRange(g.ranges.ref[jammer]!);
    const j = classByName('ATo');
    expect(callMarginVsRange(spot, j, jr, 1, [jr])).toBeLessThan(callMarginVsRange(spot, j, jr, 1));
  }, 60000);
});

describe('coach', () => {
  it('calls a jam with aces and folds 7-2 offsuit against a nit', () => {
    const aa = analyse(facingJam('nit', 'AhAd'));
    expect(aa.options[aa.best]!.opt.kind).toBe('call');
    const trash = analyse(facingJam('nit', '7h2d'));
    expect(trash.options[trash.best]!.opt.kind).toBe('fold');
  }, 60000);
  it('calls a maniac jam wider than a nit jam (the exploit shows in the type rows)', () => {
    const a = analyse(facingJam('gto', 'KhTd'));
    const call = a.options.findIndex((o) => o.opt.kind === 'call');
    const fold = a.options.findIndex((o) => o.opt.kind === 'fold');
    const margin = (style: string) => {
      const row = a.rows.find((r) => r.style === style)!;
      return row.ev[call]! - row.ev[fold]!;
    };
    expect(margin('maniac')).toBeGreaterThan(margin('nit'));
    // frequencies are a distribution
    expect(a.options.reduce((s, o) => s + o.gto, 0)).toBeCloseTo(1, 6);
  }, 60000);
  it('is deterministic: the same game gives the same advice', () => {
    const a = analyse(facingJam('lag', 'QhJh'));
    const b = analyse(facingJam('lag', 'QhJh'));
    expect(a.options.map((o) => o.ev)).toEqual(b.options.map((o) => o.ev));
  }, 60000);
});

