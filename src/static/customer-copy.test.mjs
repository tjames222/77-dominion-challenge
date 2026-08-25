import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { naturalizeDailyActionError } from './customer-copy.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const LEGACY_TERM = /\b(?:standards?|rhythms?)\b/i;
const ACCESSIBLE_ATTRIBUTE = /\b(?:alt|aria-label|aria-description|placeholder|title)=(['"])([\s\S]*?)\1/gi;

const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

function htmlCustomerCopy(source) {
  const withoutCode = source
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const textNodes = withoutCode
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const attributes = [...withoutCode.matchAll(ACCESSIBLE_ATTRIBUTE)].map((match) => match[2].trim());
  return [...textNodes, ...attributes];
}

function sourceLegacyViolations(path, source) {
  return source.split('\n').flatMap((line, index) => {
    if (!LEGACY_TERM.test(line)) return [];
    if (line.includes('customer-copy-compatibility')) return [];

    const customerCopy = line
      // Compatibility-safe routes, selectors, training targets, and storage keys.
      .replace(/standard-\$\{[^}]+\}/gi, ' ')
      .replace(/[./#\w${}-]*-standards?[./#\w${}-]*/gi, ' ')
      .replace(/\.standard\b/gi, ' ')
      .replace(/(['"])standards\1/gi, ' ')
      // Existing in-memory collection name; renaming it would add migration risk
      // without changing anything a member sees.
      .replace(/\bstandards\b(?=\s*(?:=|\.|\?\.|every\s*\(|forEach\s*\())/gi, ' ');

    return LEGACY_TERM.test(customerCopy)
      ? [`${path}:${index + 1}: ${customerCopy.trim()}`]
      : [];
  });
}

describe('FOU-1464 customer copy', () => {
  test('visible HTML text and accessible labels use Actions and natural habit language', () => {
    const htmlFiles = [
      ...readdirSync(ROOT).filter((name) => extname(name) === '.html'),
      ...readdirSync(resolve(ROOT, 'public'))
        .filter((name) => extname(name) === '.html')
        .map((name) => `public/${name}`),
    ];

    const violations = htmlFiles.flatMap((path) => htmlCustomerCopy(read(path))
      .filter((value) => LEGACY_TERM.test(value))
      .map((value) => `${path}: ${value}`));

    assert.deepEqual(violations, []);
  });

  test('runtime, training, sharing, errors, and external updates do not expose legacy terms', () => {
    const runtimeFiles = readdirSync(resolve(ROOT, 'src/static'))
      .filter((name) => ['.js', '.mjs'].includes(extname(name)) && !name.endsWith('.test.mjs'))
      .map((name) => `src/static/${name}`);
    const sources = [
      ...runtimeFiles,
      'supabase/functions/share-snapshot/index.ts',
      'supabase/functions/_shared/integration_event_renderer.ts',
    ];

    const violations = sources.flatMap((path) => sourceLegacyViolations(path, read(path)));

    assert.deepEqual(violations, []);
  });

  test('major customer areas carry the approved terminology', () => {
    assert.match(read('index.html'), />The Daily Actions</);
    assert.match(read('dashboard.html'), />Daily actions</);
    assert.match(read('src/static/streak-summary.mjs'), /Perfect-day streak/);
    assert.match(read('src/static/site-training-registry.mjs'), /seven Daily Actions/);
    assert.match(read('supabase/functions/_shared/integration_event_renderer.ts'), /of 7 actions/);
    assert.match(read('supabase/functions/share-snapshot/index.ts'), /seven daily actions/);
  });

  test('legacy database errors are translated before members see them', () => {
    const source = Object.assign(new Error('Choose a valid Daily Standard.'), {
      code: '22023',
      hint: 'Try again.',
    });

    const translated = naturalizeDailyActionError(source);

    assert.equal(translated.message, 'Choose a valid Daily Action.');
    assert.equal(translated.code, '22023');
    assert.equal(translated.hint, 'Try again.');
    assert.equal(
      naturalizeDailyActionError(new Error('That Daily Standards date is locked.')).message,
      'That Daily Actions date is locked.',
    );
  });
});
