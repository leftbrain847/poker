/**
 * A game: the tournament plus everyone's believed ranges, with the bots playing until the hero must act.
 * Deterministic: every random draw comes from the tournament seed, the hand number and the action count.
 */
import { comboIndex, mix, rng } from './cards';
import { act, newTourney, startHand, type Action, type SeatSetup, type Tourney, type TourneyConfig } from './engine';
import { freshRanges, modelOf, narrow, optFor, policy, REF_MODEL, ROW_SKILL, type Opt, type Policy, type Ranges } from './strategy';
import { STYLE_IDS } from './styles';

export interface Game {
  t: Tourney;
  hero: number;
  ranges: Ranges;
  /** Actions taken this hand (for seeding each decision's random stream). */
  step: number;
}

export function newGame(config: TourneyConfig, seats: SeatSetup[], seed: number): Game {
  const hero = Math.max(0, seats.findIndex((s) => s.hero));
  return { t: newTourney(config, seats, seed), hero, ranges: freshRanges(seats.length), step: 0 };
}

export const decisionRand = (g: Game, salt = 0): (() => number) => rng(mix(g.t.seed, g.t.handNo, g.step, salt));

/** What the bots believe: their own true range, everyone else's balanced-read range. */
export function botView(g: Game, seat: number): Float64Array[] {
  return g.ranges.ref.map((r, s) => (s === seat ? g.ranges.model[s]! : r));
}

/** Apply an action by the player to act and narrow their ranges. */
export function apply(g: Game, a: Action, botPol?: Policy): boolean {
  const h = g.t.hand!;
  const seat = h.toAct;
  const p = g.t.players[seat]!;
  const isHero = seat === g.hero;
  const refPol = policy(g.t, REF_MODEL, g.ranges.ref, decisionRand(g, 1));
  const modelPol = isHero ? refPol : botPol ?? policy(g.t, modelOf(p.style, p.skill), botView(g, seat), decisionRand(g, 2));
  const id = optFor(refPol.opts, a.kind, a.to);
  // Per-archetype reads of this player, for the coach's "vs each type" rows (the hero is always read as balanced).
  const stylePols = isHero
    ? []
    : STYLE_IDS.map((sid) => {
        const r = g.ranges.byStyle[sid];
        if (sid === p.style && p.skill === ROW_SKILL) return { r, pol: modelPol };
        const view = g.ranges.ref.map((x, s) => (s === seat ? r[s]! : x));
        return { r, pol: policy(g.t, modelOf(sid, ROW_SKILL), view, decisionRand(g, 4)) };
      });
  if (!act(g.t, a)) return false;
  narrow(g.ranges.ref[seat]!, refPol, id);
  narrow(g.ranges.model[seat]!, modelPol, id);
  for (const { r, pol } of stylePols) narrow(r[seat]!, pol, id);
  g.step++;
  return true;
}

/** The bot's choice: its policy's probabilities for the hand it actually holds. */
export function botChoice(g: Game): { opt: Opt; pol: Policy } {
  const h = g.t.hand!;
  const seat = h.toAct;
  const p = g.t.players[seat]!;
  const pol = policy(g.t, modelOf(p.style, p.skill), botView(g, seat), decisionRand(g, 2));
  const combo = comboOf(p.hole!);
  const u = decisionRand(g, 3)();
  let acc = 0;
  let opt = pol.opts[pol.opts.length - 1]!;
  const total = pol.probs.reduce((s, pr) => s + pr[combo]!, 0);
  for (let o = 0; o < pol.opts.length; o++) {
    acc += pol.probs[o]![combo]! / (total || 1);
    if (u < acc) {
      opt = pol.opts[o]!;
      break;
    }
  }
  return { opt, pol };
}

export const comboOf = (hole: [number, number]): number => comboIndex(hole[0], hole[1]);

/** Bots act until it is the hero's turn, the hand ends, or `limit` actions pass. Returns the actions taken. */
export function runBots(g: Game, limit = 100): { seat: number; opt: Opt }[] {
  const out: { seat: number; opt: Opt }[] = [];
  while (g.t.hand && g.t.hand.toAct >= 0 && g.t.hand.toAct !== g.hero && out.length < limit) {
    const seat = g.t.hand.toAct;
    const { opt, pol } = botChoice(g);
    apply(g, { kind: opt.kind, to: opt.to }, pol);
    out.push({ seat, opt });
  }
  return out;
}

/** Deal the next hand (fresh ranges). Returns false if the tournament is over. */
export function nextHand(g: Game): boolean {
  if (g.t.over) return false;
  const h = startHand(g.t);
  g.ranges = freshRanges(g.t.players.length);
  g.step = 0;
  return !!h;
}

/** Hero's turn now? */
export const heroToAct = (g: Game): boolean => !!g.t.hand && g.t.hand.toAct === g.hero && g.t.hand.street < 4;
