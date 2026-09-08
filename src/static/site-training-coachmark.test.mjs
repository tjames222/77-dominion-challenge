import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { siteTrainingGeometry, siteTrainingMobileLayout, siteTrainingTargetAvailable, siteTrainingTargetSelector } from './site-training-coachmark.mjs';

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
      const positions = viewport.width <= 640 ? [28, 120, 240] : [28, viewport.height / 2, viewport.height - 92];
      for (const y of positions) {
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

  test('phone lessons keep their natural height and a separate meaningful target region', () => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 360, height: 640 }, { width: 320, height: 568 }]) {
      const panel = { width: viewport.width - 24, height: 354, chromeHeight: 198 };
      const result = siteTrainingGeometry({ left: 20, right: viewport.width - 20, top: 20, bottom: 1200 }, panel, viewport);
      assert.equal(result.panel.maxHeight, panel.height, 'ordinary phone must show all lesson copy and actions');
      assert.equal(result.panel.top + result.panel.maxHeight, viewport.height - 12, 'card is stable at the bottom');
      assert.ok(result.hole.bottom - result.hole.top >= 100, 'real target remains meaningful above the card');
      assert.ok(result.hole.bottom + 14 <= result.panel.top, 'highlight cannot be obscured by the card');
      assert.ok(result.hole.bottom < 1200, 'oversized targets use only their visible upper region');
    }
  });

  test('mobile layout preserves action chrome at zoom and honors visual viewport safe areas', () => {
    const viewport = { left: 100, top: 50, width: 320, height: 300, padding: { left: 24, right: 20, top: 16, bottom: 28 } };
    const panel = { width: 276, height: 600, chromeHeight: 190 };
    const layout = siteTrainingMobileLayout(panel, viewport);
    assert.equal(layout.panel.left, 124);
    assert.ok(layout.panel.maxHeight >= panel.chromeHeight + 48, 'footer stays outside the clipped lesson');
    assert.equal(layout.panel.top + layout.panel.maxHeight, 322);
    assert.ok(layout.targetRegion.bottom <= layout.panel.top - 14);
    const orientation = siteTrainingMobileLayout(panel, viewport, false);
    assert.equal(orientation.panel.top, 66, 'orientation may use the whole safe viewport');
    assert.equal(orientation.panel.maxHeight, 256);
  });

  test('does not create a padded sliver for a phone target hidden beneath the card', () => {
    const panel = { width: 366, height: 354, chromeHeight: 198 };
    const viewport = { width: 390, height: 844 };
    const { targetRegion } = siteTrainingMobileLayout(panel, viewport);
    assert.equal(siteTrainingGeometry({ left: 20, right: 370, top: targetRegion.bottom + 2, bottom: 800 }, panel, viewport), null);
  });

  test('pads a sticky phone control outside its pixels even at the safe-region top', () => {
    const result = siteTrainingGeometry({ left: 136, right: 203, top: 12, bottom: 56 }, { width: 366, height: 266, chromeHeight: 190 }, { width: 390, height: 844 });
    assert.equal(result.hole.top, 4);
    assert.ok(result.hole.top + 4 < 12, '4px spotlight border must not paint over the sticky control');
    assert.ok(result.hole.bottom > 56);
    assert.ok(result.hole.bottom < result.panel.top);
  });

  test('only the lesson scrolls, controls remain a separate footer, and new steps reset reading position', async () => {
    const [source, css] = await Promise.all([read('./site-training-coachmark.mjs'), read('../assets/site-training.css')]);
    assert.match(source, /lesson\.append\(focusCue, title, description, fallback, error\)/);
    assert.match(source, /panel\.append\(header, lesson, actions\)/);
    assert.match(source, /lesson\.scrollTop = 0/);
    assert.match(source, /Highlighted above/);
    assert.match(css, /\.site-training-coachmark\s*\{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;[^}]*overflow: hidden/s);
    assert.match(css, /\.site-training-lesson\s*\{[^}]*min-height: 0;[^}]*overflow: auto/s);
    assert.match(css, /\.site-training-actions\s*\{[^}]*overflow: visible/s);
    assert.doesNotMatch(css, /@media \(max-width: 360px\)|@container \(max-width: 280px\)/);
    assert.match(css, /@container \(max-width: 230px\)/);
  });

  test('target candidate measurement excludes stale fallback copy and desktop clears phone bounds', async () => {
    const source = await read('./site-training-coachmark.mjs');
    assert.match(source, /measureLayout = \(\{ targeted = Boolean\(state\.target\) \} = \{\}\)/);
    assert.match(source, /fallback\.hidden = targeted;\s*focusCue\.hidden = !mobile \|\| !targeted;/);
    assert.match(source, /measureLayout\(\{ targeted: false \}\)/);
    assert.match(source, /if \(!state\.target\) \{\s*if \(mobile\) placePanel\(mobile\.panel\);\s*else clearPanelPosition\(\);/);
    assert.match(source, /clearPanelPosition = \(\) => \{\s*panel\.style\.removeProperty\('--site-training-left'\);\s*panel\.style\.removeProperty\('--site-training-top'\);\s*panel\.style\.removeProperty\('max-height'\);/);
  });

  test('settles only known reveal presentation temporarily and keeps action hit targets still', async () => {
    const [source, css] = await Promise.all([read('./site-training-coachmark.mjs'), read('../assets/site-training.css')]);
    assert.match(source, /observed\.matches\?\.\('\.reveal\.pending-reveal, \.reveal\.is-visible'\)/);
    assert.match(source, /state\.settledReveals\.push\(observed\)/);
    assert.match(source, /state\.settledReveals\.forEach\(\(target\) => target\.classList\.remove\('site-training-reveal-settled'\)\)/);
    assert.doesNotMatch(source, /classList\.remove\('pending-reveal'\)|classList\.add\('is-visible'\)/);
    assert.match(css, /\.site-training-reveal-settled\.reveal:is\(\.pending-reveal, \.is-visible\)[^{]+\{\s*opacity: 1;\s*transform: none;\s*filter: none;\s*transition: none;\s*animation: none;/);
    assert.match(css, /button\[data-training-action\]:is\(:hover, :active\) \{ transform: none; \}/);
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
