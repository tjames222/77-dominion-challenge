import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';

const root = new URL('../../', import.meta.url);
const stylesSource = readFileSync(new URL('../assets/styles.css', import.meta.url), 'utf8');
const activeRoutes = Object.values(PRODUCTION_ENTRYPOINTS);
const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function directPageSections(source) {
  const stack = [];
  const sections = [];
  const tokens = source.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>/gi);
  for (const match of tokens) {
    const token = match[0];
    if (token.startsWith('<!')) continue;
    const closing = /^<\//.test(token);
    const name = token.match(/^<\/?\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase();
    if (!name) continue;
    if (closing) {
      while (stack.length && stack.pop() !== name) {}
      continue;
    }
    if (name === 'section' && stack.at(-1) === 'main') {
      sections.push({
        markup: token,
        surface: token.match(/\sdata-section-surface=["'](plain|accent)["']/i)?.[1] || '',
      });
    }
    if (!voidElements.has(name) && !/\/>$/.test(token)) stack.push(name);
  }
  return sections;
}

function nestedCadenceGroups(source) {
  const stack = [];
  const groups = [];
  const tokens = source.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>/gi);
  for (const match of tokens) {
    const token = match[0];
    if (token.startsWith('<!')) continue;
    const closing = /^<\//.test(token);
    const name = token.match(/^<\/?\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase();
    if (!name) continue;
    if (closing) {
      while (stack.length && stack.pop().name !== name) {}
      continue;
    }

    const parent = stack.at(-1);
    if (Number.isInteger(parent?.cadenceGroup)) {
      groups[parent.cadenceGroup].push({
        markup: token,
        surface: token.match(/\sdata-section-surface=["'](plain|accent)["']/i)?.[1] || '',
        hidden: /\shidden(?:\s|=|>)/i.test(token),
      });
    }

    let cadenceGroup = null;
    if (/\sdata-section-cadence(?:\s|=|>)/i.test(token)) {
      cadenceGroup = groups.length;
      groups.push([]);
    }
    if (!voidElements.has(name) && !/\/>$/.test(token)) {
      stack.push({ name, cadenceGroup });
    }
  }
  return groups;
}

function assertAccentCadence(sections, label) {
  const accents = sections.filter((section) => section.surface === 'accent');
  assert.ok(accents.length <= Math.ceil(sections.length / 2), `${label} overuses accent sections`);
  sections.slice(1).forEach((section, index) => {
    assert.notEqual(
      `${sections[index].surface}:${section.surface}`,
      'accent:accent',
      `${label} has adjacent accent sections at positions ${index + 1} and ${index + 2}`,
    );
  });
}

describe('app-wide section surface cadence', () => {
  test('audits every active Vite HTML input without route exceptions', () => {
    assert.equal(activeRoutes.length, 18);
    for (const route of activeRoutes) {
      const source = readFileSync(new URL(`../../${route}`, import.meta.url), 'utf8');
      const sections = directPageSections(source);
      assert.ok(sections.length, `${route} must contain a direct page section`);
      assert.ok(sections.every((section) => section.surface), `${route} has an unclassified page section`);
    }
  });

  test('uses card surfaces as accents at most every other section in every visibility state', () => {
    for (const route of activeRoutes) {
      const source = readFileSync(new URL(`../../${route}`, import.meta.url), 'utf8');
      const sections = directPageSections(source);
      assertAccentCadence(sections, route);
    }
  });

  test('audits explicitly nested page-section cadences, including hidden states', () => {
    for (const route of activeRoutes) {
      const source = readFileSync(new URL(`../../${route}`, import.meta.url), 'utf8');
      nestedCadenceGroups(source).forEach((sections, groupIndex) => {
        const label = `${route} nested cadence ${groupIndex + 1}`;
        assert.ok(sections.length, `${label} must contain direct sections`);
        assert.ok(sections.every((section) => section.surface), `${label} has an unclassified section`);
        assertAccentCadence(sections, label);
        assertAccentCadence(
          sections.filter((section) => !section.hidden),
          `${label} without initially hidden sections`,
        );
      });
    }
  });

  test('shared CSS flattens only direct plain page sections', () => {
    const plainRule = stylesSource.match(/main\.app-shell > section\[data-section-surface="plain"\]\s*\{([^}]*)\}/)?.[1] || '';
    assert.match(plainRule, /background:\s*transparent\s*!important/);
    assert.match(plainRule, /border:\s*0\s*!important/);
    assert.match(plainRule, /box-shadow:\s*none\s*!important/);
    assert.match(stylesSource, /main\.app-shell > section\[data-section-surface="accent"\]/);
    assert.doesNotMatch(stylesSource, /main\.app-shell\s+section\[data-section-surface="plain"\]/);
  });

  test('keeps functional action and authentication controls inside the cadence', () => {
    for (const route of ['bible-reading.html', 'morning-prayer.html', 'worship.html', 'evening-prayer.html', 'workout-one.html', 'intentional-walk.html', 'workout-two.html']) {
      const source = readFileSync(new URL(`../../${route}`, import.meta.url), 'utf8');
      assert.match(source, /class="action-page-completion" data-section-surface="accent"/);
      assert.match(source, /id="actionCompletionToggle"/);
      assert.match(source, /class="action-page-content"[^>]*data-section-surface="plain"/);
    }
    for (const route of ['login.html', 'register.html']) {
      const source = readFileSync(new URL(`../../${route}`, import.meta.url), 'utf8');
      assert.match(source, /class="card auth-card" data-section-surface="accent"/);
      assert.match(source, /<form/);
    }

    const communitySource = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
    assert.match(communitySource, /class="community-tools-slot card" data-section-surface="accent"/);
    assert.match(communitySource, /class="leaderboard-card card" data-section-surface="accent"/);
    assert.doesNotMatch(communitySource, /class="(?:community-summary|group-integrations|member-activity) card"/);
  });
});
