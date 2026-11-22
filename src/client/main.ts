/**
 * Poker Coach client. Plays entirely in the browser. On the friends host it also asks the server for a
 * seed and sends each hero action to be replayed, so the result on the board is the server's. In the
 * Play build (`VITE_TARGET=play`, also the sprint demo) every network path is compiled out.
 */
import { api, configureClient } from '@app-builder/client-sdk';
import config from '../../app.config.json';
import { DEFAULT_RULES, seatsFor, tourneyConfig, type OpponentSetup } from '../app';
import { RANKS, SUITS, type Card } from '../poker/cards';
import { analyse, grade, type Analysis } from '../poker/coach';
import { alive, potTotal, STREET_NAMES, type Player } from '../poker/engine';
import { CATEGORY_NAMES, categoryOf } from '../poker/eval';
import { apply, botChoice, heroToAct, newGame, nextHand, type Game } from '../poker/game';
import { bbOf, menu, type Opt } from '../poker/strategy';
import { SKILL, STYLE_IDS, STYLES, type StyleId } from '../poker/styles';
import { el, render } from './ui';

const ONLINE = import.meta.env.VITE_TARGET !== 'play';

/** Everything tunable about the client. */
const UI = {
  botDelayMs: 520,
  botDelayFoldedMs: 220,
  storeKey: 'poker-coach:v1',
  /** Losses below this (share of a buy-in) count as a correct decision. */
  okLoss: 0.002,
  /** Matrix cell colour saturates at this loss (share of a buy-in). */
  heatMax: 0.04,
};

type CoachMode = 'live' | 'quiz' | 'off';

interface Prefs {
  mode: CoachMode;
  seats: number;
  opponents: OpponentSetup[];
}

interface Feedback {
  label: string;
  best: string;
  loss: number;
  gtoFreq: number;
  analysis: Analysis;
}

interface Stats {
  decisions: number;
  correct: number;
  lost: number;
}

interface Session {
  g: Game;
  analysis: Analysis | null;
  feedback: Feedback | null;
  stats: Stats;
  ranked: { runId: string } | null;
  lastActs: Map<number, string>;
  busy: boolean;
  showLog: boolean;
}

const DEFAULT_OPPONENTS: OpponentSetup[] = [
  { style: 'nit', skill: 3 },
  { style: 'maniac', skill: 3 },
  { style: 'station', skill: 2 },
  { style: 'lag', skill: 4 },
  { style: 'tag', skill: 4 },
  { style: 'gto', skill: 5 },
  { style: 'tag', skill: 3 },
  { style: 'station', skill: 3 },
];

function loadPrefs(): Prefs {
  const base: Prefs = { mode: 'live', seats: DEFAULT_RULES.defaultSeats, opponents: DEFAULT_OPPONENTS.slice() };
  try {
    const raw = localStorage.getItem(UI.storeKey);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<Prefs>;
    const ok = (o: OpponentSetup) => STYLE_IDS.includes(o.style) && o.skill >= 1 && o.skill <= 5;
    return {
      mode: p.mode === 'quiz' || p.mode === 'off' ? p.mode : 'live',
      seats: Number.isInteger(p.seats) && p.seats! >= DEFAULT_RULES.minSeats && p.seats! <= DEFAULT_RULES.maxSeats ? p.seats! : base.seats,
      opponents: Array.isArray(p.opponents) && p.opponents.length === 8 && p.opponents.every(ok) ? p.opponents : base.opponents,
    };
  } catch {
    return base;
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(UI.storeKey, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: preferences last for this visit only */
  }
}

const prefs = loadPrefs();
let session: Session | null = null;

const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

// ---- Formatting

const SUIT_GLYPH = ['♣', '♦', '♥', '♠'];
const SUIT_CLASS = ['club', 'diamond', 'heart', 'spade'];

function cardEl(c: Card | null, size = ''): HTMLElement {
  if (c === null) return el('span', { className: `card back ${size}`, attrs: { 'aria-label': 'hidden card' } });
  const r = RANKS[c >> 2]!;
  const s = c & 3;
  return el('span', { className: `card ${SUIT_CLASS[s]} ${size}`, attrs: { 'aria-label': `${r}${SUITS[s]}` } }, [
    el('span', { className: 'rank', text: r === 'T' ? '10' : r }),
    el('span', { className: 'suit', text: SUIT_GLYPH[s]! }),
  ]);
}

const bbStr = (chips: number, bb: number): string => {
  const x = chips / bb;
  return `${x >= 10 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, '')}bb`;
};
const pct = (x: number): string => `${Math.round(x * 100)}%`;
/** EV difference in % of a buy-in, signed. */
const evStr = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;

/** Colour family of an option, for bars and buttons. */
const family = (o: Opt): string => (o.kind === 'fold' ? 'fold' : o.kind === 'check' || o.kind === 'call' ? 'call' : o.kind === 'allin' ? 'allin' : o.id === 'small' ? 'small' : 'raise');
const shortLabel = (o: Opt): string =>
  ({ fold: 'Fold', check: 'Check', call: 'Call', raise: 'Raise', small: 'Bet ⅓', big: 'Bet ¾', allin: 'All-in' })[o.id] ?? o.label;

// ---- Setup screen

function setupScreen(): void {
  const n = prefs.seats;
  const opps = prefs.opponents.slice(0, n - 1);
  const paid = Math.max(1, Math.floor(n / 2));
  const rows = opps.map((o, i) =>
    el('div', { className: 'opp' }, [
      el('span', { className: 'opp-name', text: ['Ava', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'][i]! }),
      el(
        'div',
        { className: 'pills', attrs: { role: 'radiogroup', 'aria-label': 'Style' } },
        STYLE_IDS.map((sid) =>
          el('button', {
            className: `pill ${o.style === sid ? 'on' : ''}`,
            text: STYLES[sid].short,
            attrs: { role: 'radio', 'aria-checked': String(o.style === sid), title: STYLES[sid].name },
            onClick: () => {
              prefs.opponents[i] = { ...prefs.opponents[i]!, style: sid };
              savePrefs();
              setupScreen();
            },
          }),
        ),
      ),
      el(
        'div',
        { className: 'skill', attrs: { role: 'radiogroup', 'aria-label': `Skill: ${SKILL.names[o.skill]}` } },
        [1, 2, 3, 4, 5].map((k) =>
          el('button', {
            className: `dot ${k <= o.skill ? 'on' : ''}`,
            attrs: { role: 'radio', 'aria-checked': String(k === o.skill), title: SKILL.names[k]!, 'aria-label': `Skill ${k}: ${SKILL.names[k]}` },
            onClick: () => {
              prefs.opponents[i] = { ...prefs.opponents[i]!, skill: k };
              savePrefs();
              setupScreen();
            },
          }),
        ),
      ),
    ]),
  );
  const preset = (name: string, list: OpponentSetup[]) =>
    el('button', {
      className: 'ghost',
      text: name,
      onClick: () => {
        prefs.opponents = list.concat(DEFAULT_OPPONENTS).slice(0, 8);
        savePrefs();
        setupScreen();
      },
    });
  const randomTable = (): OpponentSetup[] => {
    const r = crypto.getRandomValues(new Uint32Array(16));
    return Array.from({ length: 8 }, (_, i) => ({ style: STYLE_IDS[r[i]! % STYLE_IDS.length]!, skill: 1 + (r[i + 8]! % 5) }));
  };
  render(
    el('main', { className: 'setup' }, [
      el('header', { className: 'brand' }, [el('h1', { text: config.title }), el('p', { className: 'muted', text: 'Double Up sit & go. Top half paid. Rising antes squeeze every stack into ICM push/fold.' })]),
      el('section', { className: 'panel' }, [
        el('div', { className: 'row between' }, [
          el('span', { className: 'label', text: 'Players' }),
          el('div', { className: 'stepper' }, [
            el('button', { className: 'ghost sq', text: '−', attrs: { 'aria-label': 'Fewer players' }, onClick: () => ((prefs.seats = Math.max(DEFAULT_RULES.minSeats, n - 1)), savePrefs(), setupScreen()) }),
            el('span', { className: 'num', text: String(n) }),
            el('button', { className: 'ghost sq', text: '+', attrs: { 'aria-label': 'More players' }, onClick: () => ((prefs.seats = Math.min(DEFAULT_RULES.maxSeats, n + 1)), savePrefs(), setupScreen()) }),
          ]),
          el('span', { className: 'muted', text: `${paid} paid` }),
        ]),
        el('div', { className: 'opps' }, rows),
        el('div', { className: 'row wrap' }, [
          el('span', { className: 'label', text: 'Tables' }),
          preset('Mixed', DEFAULT_OPPONENTS),
          preset('Tough', [{ style: 'gto', skill: 5 }, { style: 'tag', skill: 5 }, { style: 'lag', skill: 5 }, { style: 'gto', skill: 4 }, { style: 'tag', skill: 4 }]),
          preset('Soft', [{ style: 'station', skill: 1 }, { style: 'nit', skill: 2 }, { style: 'maniac', skill: 2 }, { style: 'station', skill: 2 }, { style: 'nit', skill: 1 }]),
          preset('Random', randomTable()),
        ]),
      ]),
      el('section', { className: 'panel' }, [
        el('span', { className: 'label', text: 'Coach' }),
        modeControl(() => setupScreen()),
        el('p', { className: 'muted small', text: modeHelp(prefs.mode) }),
      ]),
      el('button', { className: 'primary wide', text: 'Deal', onClick: () => void start() }),
      el('details', { className: 'legend' }, [
        el('summary', { text: 'Player types' }),
        ...STYLE_IDS.map((sid) => el('p', {}, [el('b', { text: `${STYLES[sid].short} · ${STYLES[sid].name}. ` }), el('span', { text: STYLES[sid].blurb })])),
        el('p', { className: 'muted small', text: 'Skill 1–5 sets how often a player makes random mistakes and how fully they respect ICM.' }),
      ]),
      methodNote(),
    ]),
  );
}

const modeHelp = (m: CoachMode): string =>
  m === 'live' ? 'Live: see the balanced and exploitative plays before you act.' : m === 'quiz' ? 'Quiz: act first, then see how your choice compares.' : 'Off: just play. Your decisions are still graded in the stats.';

function modeControl(onChange: () => void): HTMLElement {
  return el(
    'div',
    { className: 'seg', attrs: { role: 'radiogroup', 'aria-label': 'Coach mode' } },
    (['live', 'quiz', 'off'] as CoachMode[]).map((m) =>
      el('button', {
        className: prefs.mode === m ? 'on' : '',
        text: m === 'live' ? 'Live' : m === 'quiz' ? 'Quiz' : 'Off',
        attrs: { role: 'radio', 'aria-checked': String(prefs.mode === m) },
        onClick: () => {
          prefs.mode = m;
          savePrefs();
          onChange();
        },
      }),
    ),
  );
}

function methodNote(): HTMLElement {
  return el('details', { className: 'legend' }, [
    el('summary', { text: 'How the coach works' }),
    el('p', { text: 'All values are ICM: every outcome is scored by its share of the prize pool (Malmuth–Harville), shown in % of a buy-in. In a double up, chips you lose cost more than chips you win; the bubble factor says how much more.' }),
    el('p', { text: 'Short stacks (the heart of this format): an exact ICM push/fold equilibrium, solved live by fictitious play over all 169 hands with card removal. Overcalls behind a caller are not modelled.' }),
    el('p', { text: 'Deeper stacks and postflop: an approximation of a solver. Opening widths by seats behind, widened by antes and tightened by ICM; postflop value-to-bluff ratios from the bet size and ICM-adjusted minimum defence, with hands ranked by equity against the opponent’s range.' }),
    el('p', { text: 'The balanced bar is how an equilibrium player mixes this hand. The GTO row of the type table is different: the single best reply to balanced opponents, where several options are often within a few tenths of a percent.' }),
    el('p', { text: 'Exploit: each opponent type is a set of deviations from balanced play. Ranges are narrowed by Bayes after every action, and the coach best-responds with one street of look-ahead. That is the maximally exploitative play against that model.' }),
  ]);
}

// ---- Game flow

async function start(): Promise<void> {
  const opponents = prefs.opponents.slice(0, prefs.seats - 1);
  let seed = randomSeed();
  let ranked: Session['ranked'] = null;
  if (ONLINE) {
    configureClient({ basePath: `/${config.id}` });
    const s = await api.soloStart(config.id);
    if (s) {
      seed = s.seed;
      ranked = { runId: s.runId };
      const ok = await api.soloSegment(config.id, s.runId, { opponents });
      if (!ok || !ok.ok) ranked = null;
    }
  }
  // Same deal as the server's startGame, but the bots' first actions play out on screen.
  const seats = seatsFor(opponents);
  const g = newGame(tourneyConfig(DEFAULT_RULES, seats.length), seats, seed);
  nextHand(g);
  session = { g, analysis: null, feedback: null, stats: { decisions: 0, correct: 0, lost: 0 }, ranked, lastActs: new Map(), busy: false, showLog: false };
  afterChange();
}

/** Called after any state change: analyse if it's the hero's turn, else keep the bots moving. */
function afterChange(): void {
  const s = session!;
  const g = s.g;
  if (heroToAct(g)) {
    s.analysis = null;
    s.busy = true;
    draw();
    // Let the frame paint before the (synchronous) analysis.
    setTimeout(() => {
      s.analysis = analyse(g);
      s.busy = false;
      draw();
    }, 30);
    return;
  }
  draw();
  const h = g.t.hand;
  if (g.t.over || g.t.players[g.hero]!.place !== 0) return;
  if (h && h.street < 4 && h.toAct >= 0) {
    const heroIn = !g.t.players[g.hero]!.folded;
    setTimeout(() => {
      if (session !== s) return;
      const seat = h.toAct;
      const { opt, pol } = botChoice(g);
      apply(g, { kind: opt.kind, to: opt.to }, pol);
      s.lastActs.set(seat, opt.kind === 'raise' || opt.kind === 'allin' ? actLabel(g, seat) : shortLabel(opt));
      afterChange();
    }, heroIn ? UI.botDelayMs : UI.botDelayFoldedMs);
  }
}

function actLabel(g: Game, seat: number): string {
  const last = [...g.t.hand!.log].reverse().find((a) => a.seat === seat);
  if (!last) return '';
  const bb = bbOf(g.t);
  if (last.kind === 'allin') return 'All-in';
  if (last.kind === 'raise') return `${g.t.hand!.street === 0 ? 'Raise' : last.street === g.t.hand!.street && g.t.hand!.log.filter((a) => a.street === last.street && (a.kind === 'raise' || a.kind === 'allin')).length > 1 ? 'Raise' : 'Bet'} ${bbStr(last.to, bb)}`;
  return last.kind[0]!.toUpperCase() + last.kind.slice(1);
}

function heroAct(opt: Opt): void {
  const s = session!;
  if (s.busy || !heroToAct(s.g)) return;
  const a = s.analysis ?? analyse(s.g);
  const gr = grade(a, opt.id);
  s.stats.decisions++;
  if (gr.loss <= UI.okLoss) s.stats.correct++;
  s.stats.lost += Math.max(0, gr.loss);
  s.feedback = { label: opt.label, best: gr.bestLabel, loss: gr.loss, gtoFreq: gr.gtoFreq, analysis: a };
  s.lastActs.set(s.g.hero, shortLabel(opt));
  apply(s.g, { kind: opt.kind, to: opt.to });
  s.analysis = null;
  if (ONLINE && s.ranked) {
    void api.soloSegment(config.id, s.ranked.runId, { id: opt.id }).then((res) => {
      if (!res || !res.ok) s.ranked = null;
    });
  }
  afterChange();
}

function nextHandClick(): void {
  const s = session!;
  s.lastActs.clear();
  s.feedback = null;
  nextHand(s.g);
  afterChange();
}

// ---- Drawing

function draw(): void {
  const s = session!;
  const g = s.g;
  const t = g.t;
  const h = t.hand;
  const hero = t.players[g.hero]!;
  const heroOut = hero.place !== 0;
  const over = t.over || heroOut;
  const handDone = !!h && h.street === 4;
  const lv = h?.blinds ?? t.config.levels[0]!;
  const left = t.over ? t.players.filter((p) => p.stack > 0).length : alive(t).length;

  const header = el('header', { className: 'bar' }, [
    el('button', { className: 'ghost sq', text: '‹', attrs: { 'aria-label': 'Back to setup' }, onClick: () => ((session = null), setupScreen()) }),
    el('div', { className: 'info' }, [
      el('span', { text: `L${(h?.level ?? 0) + 1} · ${lv.sb}/${lv.bb}${lv.ante ? ` · a${lv.ante}` : ''}` }),
      el('span', { className: 'muted', text: t.over ? `Hand ${t.handNo} · finished` : `Hand ${t.handNo} · ${left} left · ${t.config.paid} paid` }),
      !t.over && left === t.config.paid + 1 ? el('span', { className: 'tag hot', text: 'Bubble' }) : null,
    ]),
    modeControl(() => draw()),
  ]);

  const table = tableView(s);
  const controls = over ? finishPanel(s) : handDone ? resultPanel(s) : actionBar(s);
  const coachOn = prefs.mode === 'live' && heroToAct(g) && !over;
  const coach = coachOn ? (s.analysis ? coachPanel(s.analysis, s) : el('section', { className: 'panel coach loading', text: 'Reading ranges…' })) : null;
  const fb = s.feedback && prefs.mode !== 'off' ? feedbackPanel(s.feedback, s) : null;

  render(
    el('main', { className: 'game' }, [
      header,
      el('div', { className: 'layout' }, [
        el('div', { className: 'left' }, [table, controls, statsLine(s)]),
        el('div', { className: 'right' }, [fb, coach, logPanel(s)]),
      ]),
    ]),
  );
}

function tableView(s: Session): HTMLElement {
  const g = s.g;
  const t = g.t;
  const h = t.hand!;
  const n = t.players.length;
  const bb = bbOf(t);
  const showdown = h.street === 4 && h.results && h.results.some((r) => r.hand);
  const seats = t.players.map((p, i) => {
    const k = (i - g.hero + n) % n;
    const ang = Math.PI / 2 + (k * 2 * Math.PI) / n;
    const x = 50 + 42 * Math.cos(ang);
    const y = 50 + 40 * Math.sin(ang);
    return seatEl(s, p, x, y, bb, !!showdown);
  });
  const pot = potTotal(t);
  const won = h.results?.filter((r) => r.won > 0) ?? [];
  return el('section', { className: 'felt', attrs: { 'aria-label': 'Table' } }, [
    el('div', { className: 'center' }, [
      el('div', { className: 'board' }, Array.from({ length: 5 }, (_, i) => (h.board[i] !== undefined ? cardEl(h.board[i]!) : el('span', { className: 'card slot' })))),
      el('div', { className: 'pot', text: h.street === 4 ? won.map((r) => `${t.players[r.seat]!.name} wins ${bbStr(r.won, bb)}`).join(' · ') : `Pot ${bbStr(pot, bb)}` }),
      el('div', { className: 'street muted', text: h.street < 4 ? STREET_NAMES[h.street]! : '' }),
    ]),
    ...seats,
  ]);
}

function seatEl(s: Session, p: Player, x: number, y: number, bb: number, showdown: boolean): HTMLElement {
  const t = s.g.t;
  const h = t.hand!;
  const isHero = p.seat === s.g.hero;
  const out = p.place !== 0 && (p.stack === 0 || t.over);
  const toAct = h.toAct === p.seat;
  const res = h.results?.find((r) => r.seat === p.seat);
  const reveal = isHero || (showdown && !!res?.hand);
  const cards = p.hole && (!p.folded || isHero) ? (reveal ? p.hole.map((c) => cardEl(c, isHero ? 'lg' : 'sm')) : [cardEl(null, 'sm'), cardEl(null, 'sm')]) : [];
  const style = STYLES[p.style as StyleId];
  const tags = [
    h.button === p.seat ? el('span', { className: 'btn-chip', text: 'D', attrs: { title: 'Button' } }) : null,
    !isHero && style ? el('span', { className: `style s-${p.style}`, text: `${style.short}·${p.skill}`, attrs: { title: `${style.name}, skill ${p.skill} (${SKILL.names[p.skill]})` } }) : null,
  ];
  const act = s.lastActs.get(p.seat);
  const handName = showdown && res?.hand ? CATEGORY_NAMES[categoryOf(res.value)] : '';
  return el(
    'div',
    {
      className: `seat ${isHero ? 'hero' : ''} ${p.folded && !out ? 'folded' : ''} ${toAct ? 'acting' : ''} ${out && p.stack === 0 ? 'out' : ''} ${res && res.won > 0 ? 'winner' : ''}`,
      style: { left: `${x}%`, top: `${y}%` },
    },
    [
      el('div', { className: 'cards' }, cards),
      el('div', { className: 'plate' }, [
        el('div', { className: 'name' }, [el('span', { text: p.name }), ...tags]),
        el('div', { className: 'stack', text: out ? (p.place <= t.config.paid ? `Paid · ${ordinal(p.place)}` : `Out · ${ordinal(p.place)}`) : bbStr(p.stack, bb) }),
      ]),
      p.bet > 0 && h.street < 4 ? el('div', { className: 'bet', text: bbStr(p.bet, bb) }) : null,
      act && h.street < 4 ? el('div', { className: 'act', text: act }) : null,
      handName ? el('div', { className: 'act', text: handName }) : null,
    ],
  );
}

const ordinal = (n: number): string => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

function actionBar(s: Session): HTMLElement {
  const g = s.g;
  if (!heroToAct(g)) {
    const folded = g.t.players[g.hero]!.folded;
    return el('section', { className: 'actions waiting' }, [el('span', { className: 'muted', text: folded ? 'You folded. The hand plays out…' : 'Waiting for opponents…' })]);
  }
  const opts = menu(g.t);
  const a = s.analysis;
  const live = prefs.mode === 'live' && a;
  return el(
    'section',
    { className: 'actions', attrs: { 'aria-label': 'Your options' } },
    opts.map((o) => {
      const adv = a?.options.find((x) => x.opt.id === o.id);
      const isBest = live && a && a.options[a.best]!.opt.id === o.id;
      return el(
        'button',
        {
          className: `act-btn f-${family(o)} ${isBest ? 'best' : ''}`,
          attrs: s.busy ? { disabled: 'true' } : {},
          onClick: () => heroAct(o),
        },
        [
          el('span', { className: 'lbl', text: o.label }),
          live && adv
            ? el('span', { className: 'sub' }, [
                el('span', { className: 'gto-mini', style: { '--w': `${Math.round(adv.gto * 100)}%` } }),
                el('span', { text: `GTO ${pct(adv.gto)}` }),
                isBest ? el('span', { className: 'star', text: '★' }) : null,
              ])
            : null,
        ],
      );
    }),
  );
}

function coachPanel(a: Analysis, s: Session): HTMLElement {
  const g = s.g;
  const sp = a.spot;
  const v = g.t.players[sp.villain]!;
  const chips: [string, string][] = [
    [sp.position, ''],
    [`${sp.effBb.toFixed(1)}bb`, 'eff'],
    [`M ${sp.m.toFixed(1)}`, ''],
  ];
  if (sp.villain !== g.hero) chips.push([`BF ${sp.bf.toFixed(2)}`, `vs ${v.name}`]);
  if (sp.facingBet) chips.push([`Need ${pct(sp.needIcm)}`, `odds ${pct(sp.potOdds)}`], [`Eq ${pct(sp.eqTable)}`, 'vs range']);
  const best = a.options[a.best]!;
  const gain = best.ev - a.evGtoMix;
  return el('section', { className: 'panel coach', attrs: { 'aria-label': 'Coach' } }, [
    el(
      'div',
      { className: 'chips' },
      chips.map(([big, small]) => el('span', { className: 'chip' }, [el('b', { text: big }), small ? el('span', { className: 'muted', text: ` ${small}` }) : null])),
    ),
    el('div', { className: 'block' }, [
      el('div', { className: 'block-h' }, [el('span', { className: 'label', text: 'Balanced (GTO)' }), el('span', { className: 'tag', text: sp.method === 'equilibrium' ? 'ICM equilibrium' : 'Approximation' })]),
      freqBar(a),
    ]),
    el('div', { className: 'block' }, [
      el('div', { className: 'block-h' }, [
        el('span', { className: 'label', text: 'Max exploit · this table' }),
        el('span', { className: 'muted small', text: gain > UI.okLoss ? `${evStr(gain)}% BI vs balanced` : 'same as balanced' }),
      ]),
      evRows(a),
    ]),
    el('div', { className: 'block' }, [
      el('div', { className: 'block-h' }, [el('span', { className: 'label', text: 'By player type' }), el('span', { className: 'muted small', text: 'EV vs best, % of a buy-in' })]),
      matrix(a),
    ]),
    el('ul', { className: 'notes' }, a.notes.map((n) => el('li', { text: n }))),
  ]);
}

function freqBar(a: Analysis): HTMLElement {
  const segs = a.options.filter((o) => o.gto > 0.005);
  return el('div', {}, [
    el(
      'div',
      { className: 'freq', attrs: { role: 'img', 'aria-label': segs.map((o) => `${o.opt.label} ${pct(o.gto)}`).join(', ') } },
      segs.map((o) => el('span', { className: `seg f-${family(o.opt)}`, style: { '--w': `${o.gto * 100}%` }, text: o.gto >= 0.14 ? `${shortLabel(o.opt)} ${pct(o.gto)}` : '' })),
    ),
    el(
      'div',
      { className: 'legend-row' },
      segs.filter((o) => o.gto < 0.14).map((o) => el('span', { className: 'muted small' }, [el('i', { className: `sw f-${family(o.opt)}` }), el('span', { text: `${shortLabel(o.opt)} ${pct(o.gto)}` })])),
    ),
  ]);
}

function evRows(a: Analysis): HTMLElement {
  const best = a.options[a.best]!.ev;
  const losses = a.options.map((o) => best - o.ev);
  const scale = Math.max(UI.heatMax, ...losses.filter((x) => x < 0.5));
  return el(
    'div',
    { className: 'evrows' },
    a.options.map((o, i) => {
      const loss = losses[i]!;
      const isBest = i === a.best;
      return el('div', { className: `evrow ${isBest ? 'best' : ''}` }, [
        el('span', { className: 'evl', text: shortLabel(o.opt) }),
        el('span', { className: 'evbar' }, [el('span', { className: `fill f-${family(o.opt)}`, style: { '--w': `${Math.max(2, 100 - (loss / scale) * 100)}%` } })]),
        el('span', { className: 'evv', text: isBest ? 'best' : evStr(-loss) }),
      ]);
    }),
  );
}

function matrix(a: Analysis): HTMLElement {
  const head = el('tr', {}, [el('th', { text: '' }), ...a.options.map((o) => el('th', { text: shortLabel(o.opt) }))]);
  const rows = a.rows.map((r) => {
    const best = r.ev[r.best]!;
    return el('tr', {}, [
      el('th', { text: r.style === 'gto' ? 'GTO' : STYLES[r.style].short, attrs: { title: STYLES[r.style].name } }),
      ...r.ev.map((e, i) => {
        const loss = best - e;
        const isBest = i === r.best;
        const heat = Math.min(1, loss / UI.heatMax);
        return el('td', { className: isBest ? 'best' : '', style: { '--h': heat.toFixed(2) }, text: isBest ? '●' : loss < 0.0005 ? '0.0' : evStr(-loss) });
      }),
    ]);
  });
  return el('table', { className: 'matrix' }, [el('thead', {}, [head]), el('tbody', {}, rows)]);
}

function feedbackPanel(f: Feedback, s: Session): HTMLElement {
  const ok = f.loss <= UI.okLoss;
  const showDetail = prefs.mode === 'quiz';
  return el('section', { className: `panel feedback ${ok ? 'good' : 'bad'}` }, [
    el('div', { className: 'row between' }, [
      el('b', { text: ok ? `✓ ${f.label}` : `✗ ${f.label}` }),
      el('span', { className: 'muted small', text: ok ? 'best vs this table' : `${evStr(-f.loss)}% BI · best: ${f.best}` }),
    ]),
    el('p', { className: 'muted small', text: `Balanced strategy plays this ${pct(f.gtoFreq)} of the time.` }),
    showDetail ? coachPanel(f.analysis, s) : null,
  ]);
}

function statsLine(s: Session): HTMLElement {
  const st = s.stats;
  return el('div', { className: 'stats muted small' }, [
    el('span', { text: `Decisions ${st.decisions}` }),
    el('span', { text: `Best ${st.decisions ? pct(st.correct / st.decisions) : '–'}` }),
    el('span', { text: `EV given up ${(st.lost * 100).toFixed(1)}% BI` }),
  ]);
}

function resultPanel(s: Session): HTMLElement {
  return el('section', { className: 'actions' }, [el('button', { className: 'primary wide', text: 'Next hand', onClick: nextHandClick })]);
}

function finishPanel(s: Session): HTMLElement {
  const t = s.g.t;
  const hero = t.players[s.g.hero]!;
  const paid = hero.place > 0 && hero.place <= t.config.paid;
  return el('section', { className: 'panel finish' }, [
    el('h2', { text: paid ? `Doubled up · ${ordinal(hero.place)}` : `Out in ${ordinal(hero.place)}` }),
    el('p', { className: 'muted', text: paid ? `You made the top ${t.config.paid}.` : `${t.config.paid} places paid.` }),
    el('div', { className: 'row' }, [
      el('button', { className: 'primary', text: 'New tournament', onClick: () => void start() }),
      el('button', { className: 'ghost', text: 'Change table', onClick: () => ((session = null), setupScreen()) }),
    ]),
  ]);
}

function logPanel(s: Session): HTMLElement {
  const t = s.g.t;
  const h = t.hand!;
  const bb = bbOf(t);
  const lines = h.log
    .filter((a) => a.kind !== 'post')
    .map((a) => `${STREET_NAMES[a.street]![0]} · ${t.players[a.seat]!.name} ${a.kind === 'raise' ? `raises to ${bbStr(a.to, bb)}` : a.kind === 'allin' ? `all in ${bbStr(a.to, bb)}` : a.kind === 'call' ? `calls ${bbStr(a.amount, bb)}` : a.kind + 's'}`);
  const d = el('details', { className: 'legend log' }, [el('summary', { text: `Hand log (${lines.length})` }), el('ol', {}, lines.map((l) => el('li', { text: l })))]);
  if (s.showLog) d.setAttribute('open', '');
  d.addEventListener('toggle', () => (s.showLog = d.open));
  return el('div', {}, [d, methodNote()]);
}

setupScreen();
