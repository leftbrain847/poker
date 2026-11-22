import { describe, expect, it } from 'vitest';
import { CARD_REMOVAL, CLASSES, classByName, comboIndex, parseCard, rng } from '../src/poker/cards';
import { categoryOf, evaluate } from '../src/poker/eval';
import { eqClass, eqVsRange, equityVsRanges, fullRange, rangeVsRange } from '../src/poker/equity';
import { bubbleFactor, doubleUpPayouts, icm, icmRequiredEquity } from '../src/poker/icm';

const cards = (s: string) => s.split(' ').map(parseCard);
const ev = (s: string) => evaluate(cards(s));

describe('evaluator', () => {
  it('ranks categories', () => {
    expect(categoryOf(ev('As Ks Qs Js Ts 2c 3d'))).toBe(8);
    expect(categoryOf(ev('9c 9d 9h 9s 2c 3d 4h'))).toBe(7);
    expect(categoryOf(ev('9c 9d 9h 2s 2c 3d 4h'))).toBe(6);
    expect(categoryOf(ev('Ah 9h 5h 3h 2h Kc Qd'))).toBe(5);
    expect(categoryOf(ev('Ac 2d 3h 4s 5c Kd 9h'))).toBe(4);
    expect(categoryOf(ev('7c 7d 7h Ks 2c 3d 9h'))).toBe(3);
    expect(categoryOf(ev('7c 7d Kh Ks 2c 3d 9h'))).toBe(2);
    expect(categoryOf(ev('7c 7d Ah Ks 2c 3d 9h'))).toBe(1);
    expect(categoryOf(ev('7c 8d Ah Ks 2c 3d Jh'))).toBe(0);
  });
  it('wheel loses to a six-high straight; kickers decide', () => {
    expect(ev('Ac 2d 3h 4s 5c Kd Kh')).toBeLessThan(ev('2d 3h 4s 5c 6c Kd Kh'));
    expect(ev('Ac Ad Kh 9s 4c 3d 2h')).toBeGreaterThan(ev('Ac Ad Qh 9s 4c 3d 2h'));
    expect(ev('Ac Ad Kh Ks 4c 3d 2h')).toBe(ev('Ah As Kd Kc 4d 3s 2c'));
    // two trips make a full house with the higher trips
    expect(categoryOf(ev('9c 9d 9h 4s 4c 4d Ah'))).toBe(6);
  });
});

describe('preflop equity table', () => {
  const near = (a: number, b: number, tol = 0.012) => expect(Math.abs(a - b)).toBeLessThan(tol);
  it('matches known all-in equities', () => {
    near(eqClass(classByName('AA'), classByName('KK')), 0.82);
    near(eqClass(classByName('AKs'), classByName('QQ')), 0.46);
    near(eqClass(classByName('AKo'), classByName('22')), 0.47);
    near(eqClass(classByName('72o'), classByName('AA')), 0.125);
    near(eqClass(classByName('JTs'), classByName('AKo')), 0.4052, 0.005); // exact enumeration, averaged over suit patterns
  });
  it('AA vs a random hand is about 85%', () => near(eqVsRange(classByName('AA'), fullRange()), 0.852, 0.01));
  it('a random hand vs random is 50%', () => near(rangeVsRange(fullRange(), fullRange()), 0.5, 0.005));
  it('card removal: AKo leaves 3 AA combos', () => {
    expect(CARD_REMOVAL[classByName('AKo') * 169 + classByName('AA')]).toBeCloseTo(3, 9);
    expect(CARD_REMOVAL[classByName('22') * 169 + classByName('AA')]).toBeCloseTo(6, 9);
    expect(CLASSES.reduce((s, c) => s + c.combos, 0)).toBe(1326);
  });
  it('postflop river equity is exact against a single combo range', () => {
    const single = new Float64Array(1326);
    single[comboIndex(parseCard('Kh'), parseCard('Kd'))] = 1;
    const board = cards('2c 7d 9h Js 3c');
    expect(equityVsRanges([parseCard('As'), parseCard('Ad')], board, [single], rng(1))).toBe(1);
    expect(equityVsRanges([parseCard('Qs'), parseCard('Qd')], board, [single], rng(1))).toBe(0);
    // turn: exact over 44 rivers; AA vs KK on 2c7d9hJs wins unless a K comes (2 outs)
    const turn = equityVsRanges([parseCard('As'), parseCard('Ad')], cards('2c 7d 9h Js'), [single], rng(1));
    expect(turn).toBeCloseTo(42 / 44, 9);
  });
});

describe('ICM', () => {
  it('equal stacks split equity equally; sums to 1', () => {
    const e = icm([1000, 1000, 1000, 1000, 1000, 1000], doubleUpPayouts(6));
    e.forEach((x) => expect(x).toBeCloseTo(1 / 6, 9));
  });
  it('double up: the chip leader is capped near a min-cash share', () => {
    const e = icm([5000, 500, 500, 500, 500, 500], doubleUpPayouts(6));
    expect(e.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(e[0]).toBeLessThanOrEqual(1 / 3 + 1e-9);
    expect(e[0]).toBeGreaterThan(0.3);
  });
  it('matches a hand-computed 3-player value', () => {
    // payouts 0.5/0.3/0.2, stacks 50/30/20: P(A 1st)=.5, A 2nd = .3*(50/70)+.2*(50/80)
    const e = icm([50, 30, 20], [0.5, 0.3, 0.2]);
    const a2 = 0.3 * (50 / 70) + 0.2 * (50 / 80);
    const a3 = 1 - 0.5 - a2;
    expect(e[0]).toBeCloseTo(0.5 * 0.5 + 0.3 * a2 + 0.2 * a3, 9);
  });
  it('bubble factors exceed 1 on a double-up bubble, and required equity rises', () => {
    const stacks = [3000, 2000, 2000, 2000];
    const bf = bubbleFactor(stacks, doubleUpPayouts(6), 1, 2);
    expect(bf).toBeGreaterThan(1.8);
    expect(icmRequiredEquity(1, 1, bf)).toBeGreaterThan(0.6);
    // heads-up winner-take-all is chip EV
    expect(bubbleFactor([1000, 1000], [1, 0], 0, 1)).toBeCloseTo(1, 9);
  });
});
