// Checks demo/clip.json, the script the index repo uses to record this app's homepage clip:
// a 4-9 s dark-mode video that plays once on hover. Steps before {"start": true} set the scene and aren't shown.
// Format: { seconds: 4-9, hash?: "x", selector?: "css", steps: [{wait: ms} | {tap: css} | {type: [css, text]} | {key: name} | {start: true}] }
import { readFileSync } from 'node:fs';

const LIMITS = { minSeconds: 4, maxSeconds: 9, maxWaitMs: 15000 };
const STEP_KINDS = ['wait', 'tap', 'type', 'key', 'start'];
const fail = (why) => { console.error(`demo/clip.json: ${why}`); process.exit(1); };

let clip;
try { clip = JSON.parse(readFileSync('demo/clip.json', 'utf8')); } catch (e) { fail(`not valid JSON (${e.message})`); }
const s = Number(clip.seconds ?? 6);
if (!(s >= LIMITS.minSeconds && s <= LIMITS.maxSeconds)) fail(`seconds must be ${LIMITS.minSeconds}-${LIMITS.maxSeconds}, got ${clip.seconds}`);
if (!Array.isArray(clip.steps)) fail('steps must be a list');
clip.steps.forEach((st, i) => {
  const kind = STEP_KINDS.filter((k) => k in (st ?? {}));
  if (kind.length !== 1) fail(`step ${i + 1} must have exactly one of ${STEP_KINDS.join(', ')}`);
  if (kind[0] === 'wait' && !(st.wait >= 0 && st.wait <= LIMITS.maxWaitMs)) fail(`step ${i + 1}: wait must be 0-${LIMITS.maxWaitMs} ms`);
  if (kind[0] === 'type' && !(Array.isArray(st.type) && st.type.length === 2)) fail(`step ${i + 1}: type is [selector, text]`);
});
if (clip.steps.filter((st) => st?.start).length > 1) fail('only one {"start": true} step');
console.log(`demo/clip.json: ${s} s, ${clip.steps.length} steps`);
