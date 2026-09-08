import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { siteTrainingGeometry, siteTrainingTargetAvailable, siteTrainingTargetSelector } from './site-training-coachmark.mjs';

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
    assert.doesNotMatch(css, /(?:backdrop-filter|filter):\s*blur\(/);
    assert.match(css, /-webkit-backdrop-filter:\s*none/);
    assert.match(css, /white-space:\s*nowrap/);
    assert.match(source, /capture:\s*true/);
    assert.match(source, /ResizeObserver\(schedulePosition\)/);
    assert.match(source, /resizeFrame = view\.requestAnimationFrame/);
    assert.match(source, /cancelAnimationFrame\?\.\(resizeFrame\)/);
    assert.doesNotMatch(source, /cloneNode|append\(state\.target|zIndex\s*=/);
  });

  test('scrim panes leave the complete target cutout clear at every supported viewport', () => {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
      for (const y of [28, viewport.height / 2, viewport.height - 92]) {
        const target = { left: 24, right: 180, top: y, bottom: y + 44 };
        const result = siteTrainingGeometry(target, { width: Math.min(410, viewport.width - 24), height: 240 }, viewport);
        assert.ok(result.hole.left < target.left && result.hole.right > target.right);
        assert.ok(result.hole.top < target.top && result.hole.bottom > target.bottom);
        const x = (target.left + target.right) / 2;
        const centerY = (target.top + target.bottom) / 2;
        for (const pane of result.panes) {
          assert.ok(pane.width >= 0 && pane.height >= 0);
          assert.equal(x > pane.left && x < pane.left + pane.width && centerY > pane.top && centerY < pane.top + pane.height, false);
        }
        assert.ok(result.panel.top + result.panel.maxHeight <= viewport.height - 12);
        assert.ok(result.panel.top >= target.bottom || result.panel.top + result.panel.maxHeight <= target.top);
      }
    }
  });

  test('uses a side when vertical placements would cover a large target', () => {
    const result = siteTrainingGeometry({ left: 80, top: 40, right: 360, bottom: 680 }, { width: 410, height: 300 }, { width: 1280, height: 720 });
    assert.ok(result.panel.left > 360);
    assert.equal(result.panel.maxHeight, 300);
  });

  test('keeps a readable corner panel when a large target leaves no usable gap', () => {
    const result = siteTrainingGeometry({ left: 80, top: 24, right: 1200, bottom: 582 }, { width: 410, height: 320 }, { width: 1280, height: 720 });
    assert.equal(result.panel.maxHeight, 240);
    assert.ok(result.panel.top >= (24 + 582) / 2);
    assert.ok(result.panel.top + result.panel.maxHeight <= 708);
  });

  test('bounds zoomed viewports and falls back for a fully clipped target', () => {
    const result = siteTrainingGeometry({ left: 130, top: 90, right: 260, bottom: 140 }, { width: 250, height: 500 }, { left: 100, top: 50, width: 320, height: 300 });
    assert.ok(result.panel.left >= 112);
    assert.ok(result.panel.top >= 62);
    assert.ok(result.panel.top + result.panel.maxHeight <= 338);
    assert.equal(siteTrainingGeometry({ left: 80, right: 70, top: 1, bottom: 50 }, { width: 100, height: 100 }, { width: 300, height: 300 }), null);
  });
});
