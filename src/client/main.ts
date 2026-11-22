/**
 * Solo client. Plays entirely in the browser. On the friends host it also
 * asks the server for a seed and sends each play to be replayed, so the score
 * on the board is the server's. In the Play build (`VITE_TARGET=play`) every
 * network path is compiled out and the run is local only.
 */
import { api, configureClient, type ScoresResponse } from '@app-builder/client-sdk';
import config from '../../app.config.json';
import { applySegment, DEFAULT_RULES, runOver, startRun, type Run } from '../app';
import { el, render } from './ui';

const ONLINE = import.meta.env.VITE_TARGET !== 'play';

interface Session {
  run: Run;
  ranked: { runId: string } | null;
  log: string[];
}

const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

async function newSession(): Promise<Session> {
  if (ONLINE) {
    configureClient({ basePath: `/${config.id}` });
    const start = await api.soloStart(config.id);
    if (start) return { run: startRun(start.seed), ranked: { runId: start.runId }, log: [] };
  }
  return { run: startRun(randomSeed()), ranked: null, log: [] };
}

async function guess(s: Session, value: number): Promise<void> {
  const seg = { play: s.run.play + 1, guess: value };
  const next = applySegment(DEFAULT_RULES, s.run, seg);
  if (!next) return;
  const gained = next.points - s.run.points;
  s.run = next;
  s.log.push(`Play ${seg.play}: guessed ${value}, ${gained === DEFAULT_RULES.rightPoints ? 'right' : 'wrong'} (+${gained})`);
  if (ONLINE && s.ranked) {
    const res = await api.soloSegment(config.id, s.ranked.runId, seg);
    if (!res || !res.ok) {
      s.ranked = null;
      s.log.push('The server could not check that play; this run is unranked.');
    }
  }
}

async function scoreboard(): Promise<ScoresResponse | null> {
  return ONLINE ? api.scores(config.id) : null;
}

async function draw(s: Session): Promise<void> {
  const over = runOver(DEFAULT_RULES, s.run);
  const buttons = over
    ? [el('button', { text: 'Play again', onClick: () => void newSession().then(draw) })]
    : [1, 2, 3, 4, 5, 6].map((n) => el('button', { text: String(n), onClick: () => void guess(s, n).then(() => draw(s)) }));
  const board = over ? await scoreboard() : null;
  render(
    el('main', {}, [
      el('h1', { text: config.title }),
      el('p', { text: over ? `Final score: ${s.run.points}` : `Play ${s.run.play + 1} of ${DEFAULT_RULES.plays}. Guess the die.` }),
      el('p', { className: 'muted', text: s.ranked ? 'Ranked run: the server checks every play.' : 'Unranked run.' }),
      el('div', { className: 'row' }, buttons),
      el('ul', {}, s.log.map((line) => el('li', { text: line }))),
      ...(board ? [el('h2', { text: 'Best scores' }), el('ol', {}, board.scores.map((e) => el('li', { text: `${e.player}: ${e.score}` })))] : []),
    ]),
  );
}

void newSession().then(draw);
