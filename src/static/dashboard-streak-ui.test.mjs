import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const dashboardHtml = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const dashboardJs = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const menuJs = readFileSync(new URL('./menu.js', import.meta.url), 'utf8');
const productCss = readFileSync(new URL('../assets/product.css', import.meta.url), 'utf8');
const dialogCss = readFileSync(new URL('../assets/dialog.css', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../assets/styles.css', import.meta.url), 'utf8');

function streakButtonMarkup() {
  const idPosition = dashboardHtml.indexOf('id="dashboardStreakButton"');
  const start = dashboardHtml.lastIndexOf('<button', idPosition);
  const end = dashboardHtml.indexOf('</button>', idPosition);
  return dashboardHtml.slice(start, end + '</button>'.length);
}

describe('Dashboard streak header experience', () => {
  test('shows only the current app streak number and lightning icon at rest', () => {
    const button = streakButtonMarkup();
    const visibleText = button
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    assert.ok(button.startsWith('<button'), 'streak control must be a native button');
    assert.match(button, /id="dashboardAppStreakCount">0</);
    assert.match(button, /class="app-icon icon-lightning"[^>]*aria-hidden="true"/);
    assert.equal(visibleText, '0');
    assert.match(button, /aria-haspopup="dialog"/);
    assert.match(button, /aria-controls="streakDetailsDialog"/);
    assert.match(button, /aria-expanded="false"/);
  });

  test('places streak immediately before the global menu in keyboard order', () => {
    const trailingStart = dashboardHtml.indexOf('<div class="topbar-trailing-actions">');
    const streakStart = dashboardHtml.indexOf('id="dashboardStreakButton"', trailingStart);
    const trailingEnd = dashboardHtml.indexOf('</div>', streakStart);

    assert.ok(trailingStart >= 0 && streakStart > trailingStart && trailingEnd > streakStart);
    assert.match(menuJs, /topbar\.querySelector\('\.topbar-trailing-actions'\)/);
    assert.match(menuJs, /\(trailingActions \|\| topbar\)\.appendChild\(button\)/);
  });

  test('removes the duplicate resting streak cards from Progress', () => {
    [
      'game-streak-grid',
      'appStreakCount',
      'appStreakBest',
      'fullDayStreakCount',
      'fullDayStreakBest',
      'Full-standard streak',
    ].forEach((legacyMarker) => {
      assert.equal(dashboardHtml.includes(legacyMarker), false, `legacy streak display returned: ${legacyMarker}`);
    });
    assert.equal(productCss.includes('.game-streak-card'), false);
  });

  test('opens the shared accessible dialog and restores state through its trigger', () => {
    assert.match(dashboardJs, /import \{ createDialog \} from '\.\/dialog\.mjs'/);
    assert.match(dashboardJs, /id: 'streakDetailsDialog'/);
    assert.match(dashboardJs, /streakDetailsDialog\?\.open\(dashboardStreakButton\)/);
    assert.match(dashboardJs, /dashboardStreakButton\.setAttribute\('aria-expanded', 'true'\)/);
    assert.match(dashboardJs, /onClose: \(\) => dashboardStreakButton\.setAttribute\('aria-expanded', 'false'\)/);
  });

  test('refreshes the resting indicator and open dialog from the same source', () => {
    const renderStart = dashboardJs.indexOf('function renderGameSummary()');
    const renderEnd = dashboardJs.indexOf('const challengeIconClass', renderStart);
    const renderBlock = dashboardJs.slice(renderStart, renderEnd);

    assert.match(renderBlock, /buildStreakSummary\(gameStats, todayKey\(\)\)/);
    assert.match(renderBlock, /renderStreakExperience\(streakSummary\)/);
    assert.match(dashboardJs, /event\.key === 'dominion:gameStats'/);
    assert.match(dashboardJs, /preserveBestStreaks\(load\('dominion:gameStats'/);
  });

  test('has keyboard, tap, responsive, reduced-motion, light, and dark styling contracts', () => {
    const buttonRule = productCss.match(/\.dashboard-streak-button\s*\{([^}]*)\}/)?.[1] || '';
    assert.match(buttonRule, /min-height:\s*46px/);
    assert.match(buttonRule, /var\(--surface\)/);
    assert.match(buttonRule, /var\(--accent-strong\)/);
    assert.match(productCss, /\.dashboard-streak-button:hover\s*\{/);
    assert.match(productCss, /\.dashboard-streak-button:active\s*\{/);
    assert.match(productCss, /\.dashboard-streak-button:focus-visible\s*\{/);
    assert.match(productCss, /:root\[data-theme="light"\] \.dashboard-streak-button/);
    assert.match(productCss, /@media \(max-width: 380px\)[\s\S]*\.streak-details-grid/);
    assert.match(productCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dashboard-streak-button/);
    assert.match(dialogCss, /@media \(max-width: 640px\)/);
    assert.match(dialogCss, /env\(safe-area-inset-bottom\)/);
    assert.match(stylesCss, /:root\s*\{[\s\S]*--surface:/);
    assert.match(stylesCss, /:root\[data-theme="light"\]\s*\{[\s\S]*--surface:/);
  });
});
