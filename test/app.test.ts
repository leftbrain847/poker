import { describe, expect, it } from 'vitest';
import { app, applySegment, DEFAULT_RULES, replay, startRun, tourneyConfig, type OpponentSetup, type Run } from '../src/app';
import { heroToAct } from '../src/poker/game';
import { menu } from '../src/poker/strategy';

const OPPS: OpponentSetup[] = [
  { style: 'nit', skill: 3 },
  { style: 'maniac', skill: 3 },
  { style: 'station', skill: 2 },
  { style: 'lag', skill: 4 },
  { style: 'tag', skill: 4 },
];

describe('solo run contract', () => {
  it('pays the top half: 6 players, 3 paid; 9 players, 4 paid', () => {
    expect(tourneyConfig(DEFAULT_RULES, 6).paid).toBe(3);
    expect(tourneyConfig(DEFAULT_RULES, 9).paid).toBe(4);
  });
  it('rejects bad setups and actions before setup', () => {
    const run = startRun(42);
    expect(applySegment(DEFAULT_RULES, run, { id: 'fold' })).toBeNull();
    expect(applySegment(DEFAULT_RULES, run, { opponents: [] })).toBeNull();
    expect(app.solo!.parseSegment({ opponents: [{ style: 'shark', skill: 3 }] })).toBeNull();
    expect(app.solo!.parseSegment({ id: 'fold' })).toEqual({ id: 'fold' });
  });
  it('replays deterministically: the same seed and actions give the same game', () => {
    let run: Run | null = applySegment(DEFAULT_RULES, startRun(7), { opponents: OPPS });
    expect(run).not.toBeNull();
    // Play the first few hero decisions with the first menu option that isn't fold (or fold).
    for (let i = 0; i < 4 && run && !run.over; i++) {
      const g = replay(DEFAULT_RULES, run)!;
      expect(heroToAct(g)).toBe(true);
      const opts = menu(g.t);
      const pick = opts.find((o) => o.kind === 'call' || o.kind === 'check') ?? opts[0]!;
      run = applySegment(DEFAULT_RULES, run, { id: pick.id });
    }
    expect(run).not.toBeNull();
    const a = replay(DEFAULT_RULES, run!)!;
    const b = replay(DEFAULT_RULES, run!)!;
    expect(JSON.stringify(a.t.players.map((p) => p.stack))).toBe(JSON.stringify(b.t.players.map((p) => p.stack)));
    expect(a.t.handNo).toBe(b.t.handNo);
    // an option id that isn't on the menu is refused
    expect(applySegment(DEFAULT_RULES, run!, { id: 'nonsense' })).toBeNull();
  }, 60000);
});
