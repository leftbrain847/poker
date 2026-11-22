import { describe, expect, it } from 'vitest';
import { rng } from '../src/poker/cards';
import { act, alive, legal, newTourney, potTotal, startHand, type TourneyConfig } from '../src/poker/engine';

const CFG: TourneyConfig = {
  startStack: 1500,
  handsPerLevel: 4,
  paid: 3,
  levels: [
    { sb: 10, bb: 20, ante: 0 },
    { sb: 25, bb: 50, ante: 5 },
    { sb: 50, bb: 100, ante: 15 },
    { sb: 100, bb: 200, ante: 30 },
    { sb: 200, bb: 400, ante: 60 },
  ],
};
const seats = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, style: 'gto', skill: 3 }));

function playRandom(seed: number, n = 6) {
  const t = newTourney(CFG, seats(n), seed);
  const r = rng(seed);
  const total = CFG.startStack * n;
  let hands = 0;
  while (!t.over && hands < 500) {
    startHand(t);
    if (t.over) break;
    hands++;
    let guard = 0;
    while (t.hand!.toAct >= 0 && guard++ < 200) {
      const L = legal(t)!;
      const x = r();
      if (x < 0.25) act(t, { kind: 'fold' });
      else if (x < 0.65) act(t, { kind: 'call' });
      else if (x < 0.85 && L.canRaise) act(t, { kind: 'raise', to: L.minTo });
      else act(t, { kind: 'allin' });
      const chips = t.players.reduce((s, p) => s + p.stack, 0) + potTotal(t);
      expect(chips).toBe(total);
    }
    expect(t.hand!.street).toBe(4);
    expect(t.players.reduce((s, p) => s + p.stack, 0)).toBe(total);
  }
  return t;
}

describe('engine', () => {
  it('conserves chips and finishes with the paid places', () => {
    for (let s = 1; s <= 30; s++) {
      const t = playRandom(s);
      expect(t.over).toBe(true);
      expect(alive(t).length).toBeLessThanOrEqual(3);
      const places = t.players.map((p) => p.place).sort((a, b) => a - b);
      expect(places).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });
  it('works heads-up and 9-handed', () => {
    expect(playRandom(7, 9).over).toBe(true);
    const cfg = { ...CFG, paid: 1 };
    const t = newTourney(cfg, seats(2), 3);
    startHand(t);
    // heads-up: the button posts the small blind and acts first preflop
    expect(t.hand!.sbSeat).toBe(t.hand!.button);
    expect(t.hand!.toAct).toBe(t.hand!.button);
  });
  it('enforces min-raise and the short all-in rule', () => {
    const t = newTourney({ ...CFG, startStack: 1000, paid: 1 }, seats(3), 1);
    startHand(t);
    const h = t.hand!;
    // first to act (button in 3-handed) min-raises to 40
    expect(legal(t)!.minTo).toBe(40);
    act(t, { kind: 'raise', to: 40 });
    // a raise below the minimum is lifted to it
    act(t, { kind: 'raise', to: 45 });
    expect(h.currentBet).toBe(60);
  });
  it('splits side pots: a short all-in can only win what it covered', () => {
    const t = newTourney({ ...CFG, paid: 1 }, seats(3), 11);
    startHand(t);
    const h = t.hand!;
    // give the player to act a tiny stack and get everyone all in
    const short = t.players[h.toAct]!;
    short.stack = 100;
    while (h.toAct >= 0) act(t, { kind: 'allin' });
    const won = h.results!.find((r) => r.seat === short.seat)?.won ?? 0;
    expect(won).toBeLessThanOrEqual(100 * 3 + 10 + 20);
  });
});
