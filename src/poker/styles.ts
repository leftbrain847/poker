/**
 * Opponent archetypes. Each is a set of deviations from the balanced (equilibrium) strategy, which is
 * how modern exploitative play is framed: find where a player's frequencies differ from equilibrium,
 * then best-respond to those frequencies. Multipliers scale range widths or action frequencies
 * (1 = balanced). Skill sets how often a player makes a random mistake and how much they respect ICM.
 */

export interface StyleParams {
  id: StyleId;
  name: string;
  short: string;
  blurb: string;
  /** How the player deviates, in one line, for the coach panel. */
  leak: string;
  /** Open-raise range width. */
  open: number;
  /** Limp instead of raising for this share of the opening range (passive players). */
  limp: number;
  /** Open-jam (push) range width when short. */
  push: number;
  /** Calling width: calling jams preflop and calling bets postflop (inverse of fold-to-bet). */
  call: number;
  /** 3-bet / re-raise width preflop. */
  threeBet: number;
  /** Postflop: how often value hands bet or raise. */
  aggression: number;
  /** Postflop: how many bluffs relative to balanced. */
  bluff: number;
  /** 0..1: how fully the player accounts for ICM (1 = fully, 0 = plays chip EV). */
  icm: number;
}

export type StyleId = 'gto' | 'tag' | 'lag' | 'nit' | 'station' | 'maniac';

export const STYLES: Record<StyleId, StyleParams> = {
  gto: {
    id: 'gto',
    name: 'Balanced (GTO)',
    short: 'GTO',
    blurb: 'Plays the equilibrium: ranges and frequencies that cannot be exploited.',
    leak: 'No leak to attack: play the equilibrium back.',
    open: 1, limp: 0, push: 1, call: 1, threeBet: 1, aggression: 1, bluff: 1, icm: 1,
  },
  tag: {
    id: 'tag',
    name: 'Tight-aggressive',
    short: 'TAG',
    blurb: 'Solid regular: a little tight, bets for value, bluffs a bit less than balanced.',
    leak: 'Slightly under-bluffs and over-folds to pressure.',
    open: 0.9, limp: 0, push: 0.9, call: 0.85, threeBet: 0.95, aggression: 1.1, bluff: 0.75, icm: 0.9,
  },
  lag: {
    id: 'lag',
    name: 'Loose-aggressive',
    short: 'LAG',
    blurb: 'Opens and 3-bets wide, barrels often, applies ICM pressure.',
    leak: 'Too many bluffs and too-wide opens: call down and re-jam lighter.',
    open: 1.45, limp: 0, push: 1.35, call: 1.15, threeBet: 1.7, aggression: 1.45, bluff: 1.7, icm: 0.75,
  },
  nit: {
    id: 'nit',
    name: 'Tight-passive (Nit)',
    short: 'NIT',
    blurb: 'Waits for big hands, folds to aggression, rarely bluffs.',
    leak: 'Over-folds and under-bluffs: steal relentlessly, fold to their aggression.',
    open: 0.6, limp: 0.15, push: 0.6, call: 0.55, threeBet: 0.45, aggression: 0.65, bluff: 0.25, icm: 1,
  },
  station: {
    id: 'station',
    name: 'Calling station',
    short: 'STN',
    blurb: 'Loose-passive: limps and calls too much, ignores ICM, rarely raises.',
    leak: 'Calls too wide and never bluffs: value bet thinner, never bluff them.',
    open: 1.25, limp: 0.6, push: 0.7, call: 1.9, threeBet: 0.35, aggression: 0.5, bluff: 0.35, icm: 0,
  },
  maniac: {
    id: 'maniac',
    name: 'Maniac',
    short: 'MAN',
    blurb: 'Raises and jams almost anything, bluffs constantly, no ICM respect.',
    leak: 'Jams and bluffs far too wide: call wider, let them bluff.',
    open: 2.3, limp: 0, push: 2.4, call: 1.5, threeBet: 2.6, aggression: 2.1, bluff: 2.6, icm: 0,
  },
};

export const STYLE_IDS = Object.keys(STYLES) as StyleId[];

/** Skill 1..5: chance of a random mistake per decision, and how much of the style's ICM respect survives. */
export const SKILL = {
  mistake: [0, 0.22, 0.14, 0.08, 0.04, 0.01] as const,
  icmScale: [0, 0.2, 0.5, 0.75, 0.9, 1] as const,
  names: ['', 'Novice', 'Casual', 'Regular', 'Strong', 'Elite'] as const,
};

export function styleOf(id: string): StyleParams {
  return STYLES[(id as StyleId) in STYLES ? (id as StyleId) : 'gto'];
}

export const icmAwareness = (style: StyleParams, skill: number): number =>
  style.icm * SKILL.icmScale[Math.max(1, Math.min(5, skill))]!;

export const mistakeRate = (skill: number): number => SKILL.mistake[Math.max(1, Math.min(5, skill))]!;
