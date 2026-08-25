import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const styles = read('../assets/styles.css');
const product = read('../assets/product.css');
const menu = read('../assets/menu.css');
const community = read('../assets/community.css');
const rewards = read('../assets/badges-rewards.css');
const training = read('../assets/site-training.css');
const dashboard = read('../../dashboard.html');
const dashboardJs = read('./dashboard.js');

describe('static phone layout contract', () => {
  test('locks the requested production viewport on every shipped route', () => {
    for (const route of Object.values(PRODUCTION_ENTRYPOINTS)) {
      const html = read(`../../${route}`);
      const viewport = html.match(/<meta name="viewport" content="([^"]+)"/i)?.[1] || '';
      assert.match(viewport, /width=device-width/);
      assert.match(viewport, /initial-scale=1/);
      assert.match(viewport, /maximum-scale=1/);
      assert.match(viewport, /user-scalable=no/);
      assert.match(viewport, /viewport-fit=cover/);
    }
  });

  test('keeps phone controls readable and removes the hard document minimum width', () => {
    assert.match(styles, /body\s*\{[\s\S]*?min-width:\s*0/);
    assert.doesNotMatch(styles, /body\s*\{[\s\S]*?min-width:\s*320px/);
    assert.match(styles, /@media \(max-width: 767px\)[\s\S]*?select,[\s\S]*?textarea\s*\{[\s\S]*?font-size:\s*16px\s*!important/);
    assert.match(styles, /main,[\s\S]*?fieldset\s*\{\s*min-width:\s*0/);
  });

  test('keeps the member row at four columns and contains disabled setup focus', () => {
    const memberTabs = product.match(/\.member-tabs\s*\{([^}]*)\}/)?.[1] || '';
    assert.match(memberTabs, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
    assert.doesNotMatch(memberTabs, /grid-template-columns:\s*repeat\(2/);
    assert.match(product, /#startChallengeButton:disabled:focus[\s\S]*?outline:\s*none;[\s\S]*?box-shadow:\s*none/);
    assert.match(product, /\.challenge-start-gate\s*\{[\s\S]*?overflow:\s*visible/);
    assert.match(dashboard, /id="startChallengeButton"[\s\S]*?disabled/);
    assert.match(dashboardJs, /startDisabled && document\.activeElement === startButton[\s\S]*?startButton\.blur\(\)/);
  });

  test('uses one safe-area-aware navigation rhythm for block and grid page shells', () => {
    assert.match(menu, /--navigation-stack-gap:\s*clamp\(8px, 1\.6vw, 12px\)/);
    assert.match(menu, /--navigation-content-gap:\s*clamp\(20px, 3\.2vw, 32px\)/);
    assert.match(menu, /min-height:\s*var\(--topbar-sticky-height\)/);
    assert.match(menu, /margin-top:\s*calc\(-1 \* max\(var\(--shell-pad,[\s\S]*?env\(safe-area-inset-top\)\)\)/);
    assert.match(menu, /padding:\s*calc\(12px \+ env\(safe-area-inset-top\)\)/);
    assert.match(menu, /\.topbar \+ \.member-tabs[\s\S]*?var\(--navigation-stack-gap\)/);
    assert.match(menu, /\.member-tabs \+ :not\(nav\)[\s\S]*?var\(--navigation-content-gap\)/);
    assert.match(menu, /\.member-tabs \+ nav[\s\S]*?var\(--navigation-stack-gap\)/);
    assert.match(menu, /body:not\(\.challenge-finished\)[\s\S]*?\.dashboard-hero[\s\S]*?min-height:\s*0/);

    assert.match(product, /\.dashboard-shell\s*\{[\s\S]*?--app-shell-row-gap:[\s\S]*?gap:\s*var\(--app-shell-row-gap\)/);
    assert.match(product, /\.membership-shell\s*\{[\s\S]*?--app-shell-row-gap:[\s\S]*?gap:\s*var\(--app-shell-row-gap\)/);
    assert.match(product, /\.legal-shell\s*\{[\s\S]*?--app-shell-row-gap:[\s\S]*?gap:\s*var\(--app-shell-row-gap\)/);
    assert.match(community, /\.community-shell\s*\{[\s\S]*?--app-shell-row-gap:\s*18px[\s\S]*?gap:\s*var\(--app-shell-row-gap\)/);
    assert.match(rewards, /\.badges-rewards-shell\s*\{[\s\S]*?--app-shell-row-gap:[\s\S]*?gap:\s*var\(--app-shell-row-gap\)/);
  });

  test('loads coachmark positioning before Solo training can isolate the page', () => {
    assert.match(menu, /^@import url\('\.\/site-training\.css'\);/);
    assert.match(training, /--site-training-styles-ready:\s*1/);
    assert.match(training, /\.site-training-layer\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0/);
    assert.match(training, /\.site-training-layer\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });
});
