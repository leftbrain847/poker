import { describe, expect, it } from 'vitest';
import { app, applySegment, DEFAULT_RULES, face, startRun } from '../src/app';

describe('app rules', () => {
  it('is deterministic: the same seed gives the same dice', () => {
    expect([1, 2, 3].map((p) => face(42, p))).toEqual([1, 2, 3].map((p) => face(42, p)));
    for (let p = 1; p <= 50; p++) expect(face(7, p)).toBeGreaterThanOrEqual(1);
  });

  it('scores right and wrong guesses, and rejects plays out of order', () => {
    const run = startRun(42);
    const right = applySegment(DEFAULT_RULES, run, { play: 1, guess: face(42, 1) });
    expect(right?.points).toBe(DEFAULT_RULES.rightPoints);
    expect(applySegment(DEFAULT_RULES, run, { play: 2, guess: 1 })).toBeNull();
  });

  it('the server replays a run to the same score the client shows', () => {
    const solo = app.solo!;
    let server = solo.start(app.defaultConfig, 9);
    let client = startRun(9);
    for (let play = 1; play <= DEFAULT_RULES.plays; play++) {
      const seg = solo.parseSegment(JSON.parse(JSON.stringify({ play, guess: 3 })));
      expect(seg).not.toBeNull();
      const out = solo.apply(app.defaultConfig, server, seg!);
      if ('error' in out) throw new Error(out.error);
      server = out.run;
      client = applySegment(DEFAULT_RULES, client, { play, guess: 3 })!;
    }
    expect(solo.isOver(server)).toBe(true);
    expect(solo.score(server)).toBe(client.points);
  });

  it('rejects malformed segments', () => {
    const solo = app.solo!;
    for (const bad of [null, [], { play: 1 }, { play: 1, guess: 7 }, { play: '1', guess: 2 }, { play: 1, guess: 2, extra: 1 }]) expect(solo.parseSegment(bad)).toBeNull();
  });
});
