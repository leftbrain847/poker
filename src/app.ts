// Note: lives at src/app.ts in a generated app; imports are relative to that location.
/**
 * Sample solo app: guess the die, three plays per run. Replace the rules with
 * your own; keep the shape. All logic is pure and deterministic (no clock, no
 * Math.random): randomness comes from the seed, so the server can replay a
 * run to check its score.
 */
import type { GameModule } from '@app-builder/host';
import config from '../app.config.json';

export interface Rules {
  plays: number;
  rightPoints: number;
  wrongPoints: number;
}

export const DEFAULT_RULES: Rules = { plays: 3, rightPoints: 10, wrongPoints: 1 };

export interface Run {
  seed: number;
  play: number;
  points: number;
}

export interface Segment {
  play: number;
  guess: number;
}

/** The die for a play: same seed and play, same face, in every JavaScript engine. */
export const face = (seed: number, play: number): number => (((seed ^ Math.imul(play, 2654435761)) >>> 0) % 6) + 1;

export const startRun = (seed: number): Run => ({ seed, play: 0, points: 0 });

export function applySegment(rules: Rules, run: Run, seg: Segment): Run | null {
  if (seg.play !== run.play + 1 || seg.play > rules.plays) return null;
  const right = seg.guess === face(run.seed, seg.play);
  return { ...run, play: seg.play, points: run.points + (right ? rules.rightPoints : rules.wrongPoints) };
}

export const runOver = (rules: Rules, run: Run): boolean => run.play >= rules.plays;

function parseSegment(raw: unknown): Segment | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== 2) return null;
  const { play, guess } = r;
  if (!Number.isInteger(play) || !Number.isInteger(guess)) return null;
  return (guess as number) >= 1 && (guess as number) <= 6 ? { play: play as number, guess: guess as number } : null;
}

export const app: GameModule<Rules, null, never, null> = {
  id: config.id,
  defaultConfig: DEFAULT_RULES,
  // Solo apps have no room; these limits are unused but required by the contract.
  limits: { tickHz: 0, snapshotHz: 0, minPlayers: 1, maxPlayers: 1, maxMsgBytes: 256, maxInputsPerSec: 5 },
  parseInput: () => null,
  init: () => null,
  onInput: () => undefined,
  viewFor: () => null,
  isOver: () => true,
  solo: {
    start: (_rules, seed) => startRun(seed),
    parseSegment,
    apply: (rules, run, seg) => {
      const next = applySegment(rules, run as Run, seg as Segment);
      return next ? { run: next } : { error: 'segment does not fit the rules' };
    },
    isOver: (run) => runOver(DEFAULT_RULES, run as Run),
    score: (run) => (run as Run).points,
    maxSegmentBytes: 256,
    maxSegments: 20,
  },
};
