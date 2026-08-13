import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const styles = read('../assets/styles.css');
const product = read('../assets/product.css');
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
});
