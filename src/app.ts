/**
 * Poker Coach: a 6-max no-limit hold'em Double Up (top half paid equally) against bot opponents, with a
 * coach that shows the balanced (GTO) play and the maximally exploitative play against each seat.
 *
 * A run is one tournament: the seed deals every hand and the hero's actions are the segments, so the
 * server can replay a run exactly. All logic is pure and deterministic (no clock, no Math.random).
 */
import type { GameModule } from '@app-builder/host';
import config from '../app.config.json';
import { type Level, type SeatSetup, type TourneyConfig } from './poker/engine';
import { apply, heroToAct, newGame, nextHand, runBots, type Game } from './poker/game';
import { menu } from './poker/strategy';
import { STYLE_IDS, type StyleId } from './poker/styles';

/** Blinds and antes by level. Antes climb fast so M collapses and the game reaches push/fold. */
export const LEVELS: Level[] = [
  { sb: 10, bb: 20, ante: 0 },
  { sb: 15, bb: 30, ante: 5 },
  { sb: 25, bb: 50, ante: 10 },
  { sb: 40, bb: 80, ante: 15 },
  { sb: 60, bb: 120, ante: 25 },
  { sb: 80, bb: 160, ante: 40 },
  { sb: 100, bb: 200, ante: 60 },
  { sb: 150, bb: 300, ante: 80 },
  { sb: 200, bb: 400, ante: 120 },
  { sb: 300, bb: 600, ante: 160 },
  { sb: 400, bb: 800, ante: 240 },
  { sb: 600, bb: 1200, ante: 320 },
];

export interface Rules {
  startStack: number;
  handsPerLevel: number;
  levels: Level[];
  minSeats: number;
  maxSeats: number;
  defaultSeats: number;
}

export const DEFAULT_RULES: Rules = { startStack: 1500, handsPerLevel: 6, levels: LEVELS, minSeats: 2, maxSeats: 9, defaultSeats: 6 };

/** Double up: the top half of the field (rounded down) is paid, each the same. */
export const tourneyConfig = (rules: Rules, seats: number): TourneyConfig => ({
  startStack: rules.startStack,
  handsPerLevel: rules.handsPerLevel,
  levels: rules.levels,
  paid: Math.max(1, Math.floor(seats / 2)),
});

export interface OpponentSetup {
  style: StyleId;
  skill: number;
}

export const BOT_NAMES = ['Ava', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'];

export function seatsFor(opponents: OpponentSetup[]): SeatSetup[] {
  return [
    { name: 'You', style: 'gto', skill: 5, hero: true },
    ...opponents.map((o, i) => ({ name: BOT_NAMES[i] ?? `Bot ${i + 1}`, style: o.style, skill: o.skill })),
  ];
}

/** Start a tournament and play the bots up to the hero's first decision. */
export function startGame(rules: Rules, opponents: OpponentSetup[], seed: number): Game {
  const seats = seatsFor(opponents);
  const g = newGame(tourneyConfig(rules, seats.length), seats, seed);
  advanceToHero(g);
  return g;
}

/** Play bots and deal new hands until the hero must act or the tournament ends. */
export function advanceToHero(g: Game): void {
  for (let guard = 0; guard < 500; guard++) {
    if (g.t.over) return;
    if (!g.t.hand || g.t.hand.street === 4) {
      if (g.t.players[g.hero]!.place !== 0) return;
      if (!nextHand(g)) return;
    }
    runBots(g);
    if (heroToAct(g)) return;
  }
}

// ---- Solo run contract: the seed plus the opponents set up, then one segment per hero action.

export interface Run {
  seed: number;
  opponents: OpponentSetup[];
  actions: { id: string }[];
  over: boolean;
  place: number;
}

export interface Segment {
  /** First segment only: the opponents. */
  opponents?: OpponentSetup[];
  /** The option id chosen (from the coach's menu: fold, check, call, raise, small, big, allin). */
  id?: string;
}

export const startRun = (seed: number): Run => ({ seed, opponents: [], actions: [], over: false, place: 0 });

/** Rebuild the game from a run (server replay). */
export function replay(rules: Rules, run: Run): Game | null {
  if (!run.opponents.length) return null;
  const g = startGame(rules, run.opponents, run.seed);
  for (const a of run.actions) {
    if (!heroToAct(g)) return null;
    const opt = menu(g.t).find((o) => o.id === a.id);
    if (!opt) return null;
    apply(g, { kind: opt.kind, to: opt.to });
    advanceToHero(g);
  }
  return g;
}

export function applySegment(rules: Rules, run: Run, seg: Segment): Run | null {
  if (run.over) return null;
  if (seg.opponents) {
    if (run.opponents.length) return null;
    const n = seg.opponents.length + 1;
    if (n < rules.minSeats || n > rules.maxSeats) return null;
    if (!seg.opponents.every((o) => STYLE_IDS.includes(o.style) && Number.isInteger(o.skill) && o.skill >= 1 && o.skill <= 5)) return null;
    const next = { ...run, opponents: seg.opponents };
    const g = replay(rules, next);
    return g ? { ...next, over: g.t.over || g.t.players[0]!.place > 0, place: g.t.players[0]!.place } : null;
  }
  if (!seg.id || !run.opponents.length) return null;
  const next = { ...run, actions: [...run.actions, { id: seg.id }] };
  const g = replay(rules, next);
  if (!g) return null;
  return { ...next, over: g.t.over || g.t.players[0]!.place > 0, place: g.t.players[0]!.place };
}

/** Score: a paid finish is worth the most; higher places score more. */
export const score = (run: Run): number => (run.place > 0 ? 100 - run.place : 0);

function parseSegment(raw: unknown): Segment | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id === 'string' && Object.keys(r).length === 1 && /^[a-z]{1,8}$/.test(r.id)) return { id: r.id };
  if (Array.isArray(r.opponents) && Object.keys(r).length === 1 && r.opponents.length <= 8) {
    const opponents: OpponentSetup[] = [];
    for (const o of r.opponents) {
      if (typeof o !== 'object' || o === null) return null;
      const { style, skill } = o as Record<string, unknown>;
      if (typeof style !== 'string' || !STYLE_IDS.includes(style as StyleId) || !Number.isInteger(skill)) return null;
      opponents.push({ style: style as StyleId, skill: skill as number });
    }
    return { opponents };
  }
  return null;
}

export const app: GameModule<Rules, null, never, null> = {
  id: config.id,
  defaultConfig: DEFAULT_RULES,
  // Solo apps have no room; these limits are unused but required by the contract.
  limits: { tickHz: 0, snapshotHz: 0, minPlayers: 1, maxPlayers: 1, maxMsgBytes: 512, maxInputsPerSec: 5 },
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
    isOver: (run) => (run as Run).over,
    score: (run) => score(run as Run),
    maxSegmentBytes: 512,
    maxSegments: 600,
  },
};
