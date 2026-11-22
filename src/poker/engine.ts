/**
 * No-limit hold'em tournament engine: seats, blinds and antes by level, betting rounds with correct
 * min-raise and short all-in rules, side pots, showdowns, eliminations and finishing places.
 * Pure and deterministic: the deck for each hand comes from the tournament seed.
 */
import { mix, shuffled, type Card } from './cards';
import { evaluate } from './eval';

export interface Level {
  sb: number;
  bb: number;
  ante: number;
}

export interface TourneyConfig {
  startStack: number;
  handsPerLevel: number;
  levels: Level[];
  /** Number of places paid; each paid place wins the same (a double up pays the top half). */
  paid: number;
}

export interface SeatSetup {
  name: string;
  style: string;
  skill: number;
  hero?: boolean;
}

export interface Player extends SeatSetup {
  seat: number;
  stack: number;
  /** Chips put in during the current betting round. */
  bet: number;
  /** Chips put in this hand (all rounds, antes included). */
  committed: number;
  folded: boolean;
  allIn: boolean;
  hole: [Card, Card] | null;
  /** 0 while still playing; otherwise the finishing place (1 = best). */
  place: number;
  /** Stack at the start of the hand. */
  startStack: number;
}

export type ActionKind = 'fold' | 'check' | 'call' | 'raise' | 'allin';

export interface Action {
  kind: ActionKind;
  /** For raise: the total bet this round after raising. */
  to?: number;
}

export interface LoggedAction {
  seat: number;
  kind: ActionKind | 'post';
  amount: number;
  street: number;
  /** Total bet of the seat this round after the action. */
  to: number;
  note?: string;
}

export interface Showdown {
  seat: number;
  won: number;
  hand: [Card, Card] | null;
  value: number;
}

export interface HandState {
  no: number;
  level: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  board: Card[];
  deck: Card[];
  street: number; // 0 preflop .. 3 river; 4 = hand over
  toAct: number; // -1 when no one is to act
  currentBet: number;
  lastRaiseSize: number;
  /** Seats that still need to act at the current bet. */
  pending: number[];
  /** Seats that have acted since the last full raise: a short all-in doesn't let them re-raise. */
  acted: number[];
  log: LoggedAction[];
  results: Showdown[] | null;
  /** Antes and blinds of this hand, for the record. */
  blinds: Level;
}

export interface Tourney {
  config: TourneyConfig;
  seed: number;
  players: Player[];
  handNo: number;
  hand: HandState | null;
  over: boolean;
  /** Seat of the next button. */
  nextButton: number;
}

export const STREET_NAMES = ['Preflop', 'Flop', 'Turn', 'River'];

export function newTourney(config: TourneyConfig, seats: SeatSetup[], seed: number): Tourney {
  const players: Player[] = seats.map((s, i) => ({
    ...s,
    seat: i,
    stack: config.startStack,
    bet: 0,
    committed: 0,
    folded: false,
    allIn: false,
    hole: null,
    place: 0,
    startStack: config.startStack,
  }));
  return { config, seed, players, handNo: 0, hand: null, over: false, nextButton: (seed >>> 0) % seats.length };
}

export const alive = (t: Tourney): Player[] => t.players.filter((p) => p.place === 0);

const nextAlive = (t: Tourney, from: number): number => {
  const n = t.players.length;
  for (let k = 1; k <= n; k++) {
    const s = (from + k) % n;
    if (t.players[s]!.place === 0) return s;
  }
  return from;
};

export const levelFor = (config: TourneyConfig, handNo: number): number =>
  Math.min(config.levels.length - 1, Math.floor((handNo - 1) / config.handsPerLevel));

/** Seats in the order they act preflop or postflop for the current hand, among those still in. */
export function actingOrder(t: Tourney, street: number): number[] {
  const h = t.hand!;
  const n = t.players.length;
  const live = alive(t).length;
  // Preflop: first to act is after the big blind. Postflop: first after the button.
  // Heads-up: the button is the small blind and acts first preflop, last postflop.
  const start = street === 0 ? (live === 2 ? h.button : nextAlive(t, h.bbSeat)) : nextAlive(t, h.button);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = (start + k) % n;
    const p = t.players[s]!;
    if (p.place === 0 && p.hole) out.push(s);
  }
  return out;
}

function post(t: Tourney, seat: number, amount: number, kind: 'post', note: string): void {
  const p = t.players[seat]!;
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  p.committed += a;
  if (note !== 'ante') p.bet += a;
  if (p.stack === 0) p.allIn = true;
  t.hand!.log.push({ seat, kind, amount: a, street: 0, to: p.bet, note });
}

export function startHand(t: Tourney): HandState | null {
  if (t.over) return null;
  const players = alive(t);
  if (players.length <= Math.max(1, t.config.paid)) {
    finish(t);
    return null;
  }
  t.handNo++;
  const levelIdx = levelFor(t.config, t.handNo);
  const lv = t.config.levels[levelIdx]!;
  const button = t.players[t.nextButton]!.place === 0 ? t.nextButton : nextAlive(t, t.nextButton);
  const headsUp = players.length === 2;
  const sbSeat = headsUp ? button : nextAlive(t, button);
  const bbSeat = nextAlive(t, sbSeat);
  const deck = shuffled(mix(t.seed, t.handNo));
  for (const p of t.players) {
    p.bet = 0;
    p.committed = 0;
    p.folded = p.place !== 0;
    p.allIn = false;
    p.hole = null;
    p.startStack = p.stack;
  }
  t.hand = {
    no: t.handNo,
    level: levelIdx,
    button,
    sbSeat,
    bbSeat,
    board: [],
    deck,
    street: 0,
    toAct: -1,
    currentBet: 0,
    lastRaiseSize: lv.bb,
    pending: [],
    acted: [],
    log: [],
    results: null,
    blinds: lv,
  };
  let d = 0;
  for (const s of orderFrom(t, sbSeat)) {
    t.players[s]!.hole = [deck[d]!, deck[d + 1]!];
    d += 2;
  }
  t.hand.deck = deck.slice(d);
  if (lv.ante > 0) for (const p of alive(t)) post(t, p.seat, lv.ante, 'post', 'ante');
  post(t, sbSeat, lv.sb, 'post', 'small blind');
  post(t, bbSeat, lv.bb, 'post', 'big blind');
  t.hand.currentBet = Math.max(...alive(t).map((p) => p.bet));
  t.hand.pending = actingOrder(t, 0).filter((s) => !t.players[s]!.allIn);
  advance(t);
  return t.hand;
}

function orderFrom(t: Tourney, start: number): number[] {
  const n = t.players.length;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = (start + k) % n;
    if (t.players[s]!.place === 0) out.push(s);
  }
  return out;
}

export interface Legal {
  toCall: number;
  canCheck: boolean;
  canRaise: boolean;
  /** Smallest legal raise-to (total this round); equals maxTo when only an all-in is possible. */
  minTo: number;
  /** All-in raise-to. */
  maxTo: number;
}

export function legal(t: Tourney): Legal | null {
  const h = t.hand;
  if (!h || h.toAct < 0) return null;
  const p = t.players[h.toAct]!;
  const toCall = Math.min(h.currentBet - p.bet, p.stack);
  const maxTo = p.bet + p.stack;
  const minTo = Math.min(maxTo, h.currentBet + h.lastRaiseSize);
  // Raising is allowed if the player has more than a call and someone else could still respond.
  const others = alive(t).filter((o) => o.seat !== p.seat && !o.folded && !o.allIn);
  const canRaise = maxTo > h.currentBet && others.length > 0 && !h.acted.includes(p.seat);
  return { toCall, canCheck: toCall === 0, canRaise, minTo, maxTo };
}

/** Apply an action for the player to act. Returns false if it isn't legal. */
export function act(t: Tourney, a: Action): boolean {
  const h = t.hand;
  const L = legal(t);
  if (!h || !L) return false;
  const p = t.players[h.toAct]!;
  const removePending = () => (h.pending = h.pending.filter((s) => s !== p.seat));
  const put = (amount: number) => {
    const x = Math.min(amount, p.stack);
    p.stack -= x;
    p.bet += x;
    p.committed += x;
    if (p.stack === 0) p.allIn = true;
  };
  switch (a.kind) {
    case 'fold':
      if (L.canCheck) return act(t, { kind: 'check' });
      p.folded = true;
      removePending();
      h.log.push({ seat: p.seat, kind: 'fold', amount: 0, street: h.street, to: p.bet });
      break;
    case 'check':
      if (!L.canCheck) return false;
      removePending();
      h.log.push({ seat: p.seat, kind: 'check', amount: 0, street: h.street, to: p.bet });
      break;
    case 'call': {
      if (L.canCheck) return act(t, { kind: 'check' });
      put(L.toCall);
      removePending();
      h.log.push({ seat: p.seat, kind: p.allIn ? 'allin' : 'call', amount: L.toCall, street: h.street, to: p.bet });
      break;
    }
    case 'raise':
    case 'allin': {
      const to = a.kind === 'allin' ? L.maxTo : Math.max(L.minTo, Math.min(L.maxTo, Math.round(a.to ?? L.minTo)));
      if (to <= h.currentBet) return act(t, { kind: 'call' });
      if (!L.canRaise) return act(t, { kind: 'call' });
      const raiseSize = to - h.currentBet;
      const full = raiseSize >= h.lastRaiseSize;
      put(to - p.bet);
      h.log.push({ seat: p.seat, kind: p.allIn ? 'allin' : 'raise', amount: raiseSize, street: h.street, to: p.bet });
      h.currentBet = p.bet;
      if (full) {
        h.lastRaiseSize = raiseSize;
        h.acted = [];
        // A full raise reopens the action for everyone still able to act.
        h.pending = orderAfter(t, p.seat).filter((s) => !t.players[s]!.folded && !t.players[s]!.allIn);
      } else {
        // A short all-in: players who already acted may only call or fold (they stay off `pending`),
        // but anyone facing more chips must respond.
        const need = orderAfter(t, p.seat).filter((s) => {
          const o = t.players[s]!;
          return !o.folded && !o.allIn && o.bet < h.currentBet;
        });
        h.pending = need;
      }
      break;
    }
  }
  if (!h.acted.includes(p.seat)) h.acted.push(p.seat);
  advance(t);
  return true;
}

function orderAfter(t: Tourney, seat: number): number[] {
  const n = t.players.length;
  const out: number[] = [];
  for (let k = 1; k < n; k++) {
    const s = (seat + k) % n;
    const p = t.players[s]!;
    if (p.place === 0 && p.hole && !p.folded) out.push(s);
  }
  return out;
}

const inHand = (t: Tourney): Player[] => t.players.filter((p) => p.place === 0 && p.hole && !p.folded);

export const potTotal = (t: Tourney): number => t.players.reduce((s, p) => s + p.committed, 0);

/** Move to the next player, the next street, or the showdown. */
function advance(t: Tourney): void {
  const h = t.hand!;
  const live = inHand(t);
  if (live.length === 1) {
    award(t);
    return;
  }
  const next = h.pending.find((s) => {
    const p = t.players[s]!;
    return !p.folded && !p.allIn;
  });
  if (next !== undefined) {
    // Nobody left to respond: a lone player with chips facing no bet doesn't need to act.
    const canAct = live.filter((p) => !p.allIn);
    const p = t.players[next]!;
    if (canAct.length === 1 && p.bet >= h.currentBet) {
      h.pending = [];
    } else {
      h.toAct = next;
      return;
    }
  }
  // Betting round over: return any uncalled chips, then deal on.
  returnUncalled(t);
  const canAct = live.filter((p) => !p.allIn);
  if (h.street === 3) {
    award(t);
    return;
  }
  for (const p of t.players) p.bet = 0;
  h.currentBet = 0;
  h.lastRaiseSize = h.blinds.bb;
  h.acted = [];
  h.street++;
  const n = h.street === 1 ? 3 : 1;
  h.board.push(...h.deck.slice(0, n));
  h.deck = h.deck.slice(n);
  h.pending = canAct.length >= 2 ? actingOrder(t, h.street).filter((s) => !t.players[s]!.folded && !t.players[s]!.allIn) : [];
  h.toAct = -1;
  advance(t);
}

function returnUncalled(t: Tourney): void {
  const live = inHand(t);
  const bets = live.map((p) => p.bet).sort((a, b) => b - a);
  const top = bets[0] ?? 0;
  const second = bets[1] ?? 0;
  if (top > second) {
    const p = live.find((x) => x.bet === top)!;
    const back = top - second;
    p.bet -= back;
    p.committed -= back;
    p.stack += back;
    if (p.stack > 0) p.allIn = false;
  }
}

/** Split the pot (with side pots) among the best hands. Odd chips go to the first winner left of the button. */
function award(t: Tourney): void {
  const h = t.hand!;
  returnUncalled(t);
  const live = inHand(t);
  // Deal out the board if players are all in before the river.
  if (live.length > 1) {
    while (h.board.length < 5) {
      h.board.push(h.deck[0]!);
      h.deck = h.deck.slice(1);
    }
  }
  const value = new Map<number, number>();
  for (const p of live) value.set(p.seat, live.length > 1 ? evaluate([...p.hole!, ...h.board]) : 0);
  const won = new Map<number, number>();
  const contrib = t.players.map((p) => p.committed);
  const levels = [...new Set(contrib.filter((c) => c > 0))].sort((a, b) => a - b);
  let prev = 0;
  const order = orderFrom(t, nextAlive(t, h.button));
  for (const lvl of levels) {
    const layer = contrib.reduce((s, c) => s + Math.max(0, Math.min(c, lvl) - prev), 0);
    const eligible = live.filter((p) => p.committed >= lvl);
    if (layer > 0) {
      const winners = eligible.length ? bestOf(eligible, value) : [];
      if (winners.length === 0) {
        // Everyone who reached this layer folded: it goes to the remaining player(s) with the most in.
        const fallback = bestOf(live, value);
        split(layer, fallback, won, order);
      } else split(layer, winners, won, order);
    }
    prev = lvl;
  }
  for (const [seat, amt] of won) t.players[seat]!.stack += amt;
  h.results = live.map((p) => ({ seat: p.seat, won: won.get(p.seat) ?? 0, hand: live.length > 1 ? p.hole : null, value: value.get(p.seat) ?? 0 }));
  for (const [seat, amt] of won) if (!live.some((p) => p.seat === seat)) h.results.push({ seat, won: amt, hand: null, value: 0 });
  h.street = 4;
  h.toAct = -1;
  h.pending = [];
  eliminate(t);
  t.nextButton = nextAlive(t, h.button);
}

function bestOf(ps: Player[], value: Map<number, number>): Player[] {
  const best = Math.max(...ps.map((p) => value.get(p.seat) ?? 0));
  return ps.filter((p) => (value.get(p.seat) ?? 0) === best);
}

function split(amount: number, winners: Player[], won: Map<number, number>, order: number[]): void {
  const sorted = winners.slice().sort((a, b) => order.indexOf(a.seat) - order.indexOf(b.seat));
  const share = Math.floor(amount / sorted.length);
  let odd = amount - share * sorted.length;
  for (const w of sorted) {
    won.set(w.seat, (won.get(w.seat) ?? 0) + share + (odd > 0 ? 1 : 0));
    if (odd > 0) odd--;
  }
}

/** Players who hit zero get a place. Several in one hand: the bigger starting stack finishes higher. */
function eliminate(t: Tourney): void {
  const busted = t.players.filter((p) => p.place === 0 && p.stack === 0).sort((a, b) => a.startStack - b.startStack);
  let remaining = alive(t).length;
  for (const p of busted) {
    p.place = remaining;
    remaining--;
  }
  if (alive(t).length <= t.config.paid) finish(t);
}

function finish(t: Tourney): void {
  const left = alive(t).sort((a, b) => b.stack - a.stack);
  // Everyone still in is paid the same in a double up; places among them follow chip counts.
  left.forEach((p, i) => (p.place = i + 1));
  t.over = true;
}

/** Effective stack (in chips) of a player against the others still in the hand. */
export function effectiveStack(t: Tourney, seat: number): number {
  const me = t.players[seat]!;
  const mine = me.stack + me.bet;
  const others = inHand(t).filter((p) => p.seat !== seat).map((p) => p.stack + p.bet);
  return Math.min(mine, Math.max(0, ...others));
}

export const isPaid = (t: Tourney, p: Player): boolean => p.place > 0 && p.place <= t.config.paid;
