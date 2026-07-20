import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const root = new URL('../../', import.meta.url);
const viteSource = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../assets/styles.css', import.meta.url), 'utf8');
const activeRoutes = [...viteSource.matchAll(/\w+:\s*'([^']+\.html)'/g)].map((match) => match[1]);
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
      const accents = sections.filter((section) => section.surface === 'accent');
      assert.ok(accents.length <= Math.ceil(sections.length / 2), `${route} overuses accent sections`);
      sections.slice(1).forEach((section, index) => {
        assert.notEqual(
          `${sections[index].surface}:${section.surface}`,
          'accent:accent',
          `${route} has adjacent accent sections at positions ${index + 1} and ${index + 2}`,
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
  });
});
