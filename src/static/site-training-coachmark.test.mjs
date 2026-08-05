import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { siteTrainingTargetAvailable, siteTrainingTargetSelector } from './site-training-coachmark.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('site training coachmark foundation', () => {
  test('accepts stable target tokens but never arbitrary selectors', () => {
    assert.equal(siteTrainingTargetSelector('dashboard-progress'), '[data-training-target="dashboard-progress"]');
    assert.equal(siteTrainingTargetSelector('#checkInButton'), '');
    assert.equal(siteTrainingTargetSelector('button[onclick]'), '');
  });

  test('falls back for hidden and unavailable targets', () => {
    const visible = {
      hidden: false,
      closest: () => null,
      getClientRects: () => [{}],
    };
    assert.equal(siteTrainingTargetAvailable(visible, { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }), true);
    assert.equal(siteTrainingTargetAvailable({ ...visible, hidden: true }), false);
    assert.equal(siteTrainingTargetAvailable(visible, { getComputedStyle: () => ({ display: 'none', visibility: 'visible' }) }), false);
  });

  test('owns an accessible modal, blocks product interaction, and covers responsive preferences', async () => {
    const [source, css] = await Promise.all([
      read('./site-training-coachmark.mjs'),
      read('../assets/site-training.css'),
    ]);
    assert.match(source, /role', 'dialog'/);
    assert.match(source, /aria-modal', 'true'/);
    assert.match(source, /acquireDialogLayer\(\{/);
    assert.match(source, /title\.focus\?\.\(\{ preventScroll: true \}\)/);
    assert.match(source, /role', 'alert'/);
    assert.match(source, /aria-live', 'polite'/);
    assert.doesNotMatch(source, /\.click\?\.|\.click\(/);
    assert.match(css, /\.site-training-actions button\s*\{\s*min-height:\s*44px/);
    assert.match(css, /@media \(max-width: 640px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
  });
});
