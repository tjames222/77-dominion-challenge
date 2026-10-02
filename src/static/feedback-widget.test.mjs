import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./feedback-widget.mjs', import.meta.url), 'utf8');
const projection = source.match(/const FEEDBACK_GAP[\s\S]*?(?=\/\/ Mounted only)/u)?.[0];
assert.ok(projection, 'feedback placement projection must remain source-visible');
const feedbackLiftForObstructions = new Function(`${projection.replace('export function', 'function')}\nreturn feedbackLiftForObstructions;`)();
const anchor = Object.freeze({ left: 100, right: 156, top: 700, bottom: 756 });

test('floating feedback stays at its bottom-right anchor when the edge is clear', () => {
  assert.deepEqual(feedbackLiftForObstructions({ anchor, obstructions: [
    { left: 0, right: 80, top: 700, bottom: 780 },
  ] }), { lift: 0, clear: true });
});

test('floating feedback clears one or several visible actions without changing its right edge', () => {
  assert.deepEqual(feedbackLiftForObstructions({ anchor, obstructions: [
    { left: 0, right: 400, top: 720, bottom: 780 },
  ] }), { lift: 44, clear: true });
  assert.deepEqual(feedbackLiftForObstructions({ anchor, obstructions: [
    { left: 0, right: 400, top: 720, bottom: 780 },
    { left: 0, right: 400, top: 650, bottom: 710 },
  ] }), { lift: 114, clear: true });
});

test('floating feedback fails closed when no unobstructed viewport position exists', () => {
  assert.deepEqual(feedbackLiftForObstructions({ anchor: { ...anchor, top: 24, bottom: 80 }, viewportTop: 20 }),
    { lift: 0, clear: false });
  assert.deepEqual(feedbackLiftForObstructions({ anchor, viewportTop: 0, obstructions: [
    { left: 0, right: 400, top: 0, bottom: 800 },
  ] }), { lift: 692, clear: false });
  for (const value of [null, {}, { ...anchor, bottom: Infinity }]) {
    assert.throws(() => feedbackLiftForObstructions({ anchor: value }), TypeError);
  }
});

test('feedback launcher is always a safe-area fixed control and never a header slot', () => {
  const css = readFileSync(new URL('./feedback-widget.css', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /feedback-header-slot|matchMedia|\.topbar/u);
  assert.match(source, /ownerDocument\.body\.append\(button\)/u);
  assert.match(source, /FEEDBACK_HIT_GRID\s*=\s*5/u);
  assert.match(source, /FEEDBACK_PLACEMENT_PASSES\s*=\s*10/u);
  assert.match(source, /ownerDocument\.elementsFromPoint\(x, y\)/u);
  assert.doesNotMatch(source, /querySelectorAll\(FEEDBACK_OBSTRUCTIONS\)/u);
  assert.match(css, /\.feedback-widget\s*\{[\s\S]*?position:\s*fixed;/u);
  assert.match(css, /--feedback-safe-right:\s*env\(safe-area-inset-right,\s*0px\)/u);
  assert.match(css, /--feedback-safe-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/u);
  assert.match(css, /right:[^;]*--feedback-safe-right[^;]*--feedback-viewport-right/u);
  assert.match(css, /bottom:[^;]*--feedback-safe-bottom[^;]*--feedback-viewport-bottom[^;]*--feedback-lift/u);
  assert.match(css, /--feedback-safe-top:\s*env\(safe-area-inset-top,\s*0px\)/u);
  assert.match(css, /min-width:\s*44px;[\s\S]*?min-height:\s*44px;/u);
  assert.match(css, /\.feedback-widget\[data-obstructed\][\s\S]*?visibility:\s*hidden;\s*pointer-events:\s*none;/u);
  assert.match(css, /body\.challenge-finished \.feedback-widget\s*\{\s*z-index:\s*1180;/u);
  assert.match(css, /body\.challenge-finished \.app-dialog-layer\[data-pattern="feedback"\]\s*\{\s*z-index:\s*1185;/u);
  assert.doesNotMatch(css, /feedback-header-slot/u);
  for (const selector of ['menu-open', 'data-dialog-open', 'dialog:modal', 'permanent-reward-celebration',
    'reward-backdrop.active', 'reward-toast.active', 'badge-celebration.active', 'crew-training-layer', 'site-training-layer']) {
    assert.ok(css.includes(selector), `missing overlay guard: ${selector}`);
  }
});

test('motion settlement uses the bounded scheduler and removes every captured listener on teardown', () => {
  assert.match(source, /FEEDBACK_SETTLEMENT_EVENTS = \['transitionend', 'transitioncancel', 'animationend', 'animationcancel'\]/u);
  assert.match(source, /for \(const event of FEEDBACK_SETTLEMENT_EVENTS\) ownerDocument\.addEventListener\(event, schedulePlacement, \{ passive: true, capture: true \}\)/u);
  assert.match(source, /for \(const event of FEEDBACK_SETTLEMENT_EVENTS\) ownerDocument\.removeEventListener\(event, schedulePlacement, true\)/u);
  assert.match(source, /function schedulePlacement\(\) \{\s*if \(destroyed \|\| placementFrame\) return;/u);
});
