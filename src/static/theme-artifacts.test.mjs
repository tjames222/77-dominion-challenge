import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { verifyThemeArtifacts } from '../../scripts/verify-theme-artifacts.mjs';

const source = await readFile(new URL('../../public/theme-bootstrap.js', import.meta.url), 'utf8');
const profile = ':root[data-theme="dominion-night"]{--background:#071317;--surface:#123;--text:#fff;--accent:#abc;--focus-ring:#fff}';
const html = (flag = 'true') => `<script src="./theme-bootstrap.js" data-enable-dominion-night="${flag}"></script><link rel="stylesheet" href="./theme.css">`;

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), '77dc-theme-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries({
    'index.html': html(),
    'profile.html': html(),
    'theme-bootstrap.js': source,
    'theme.css': profile,
    ...overrides,
  })) await writeFile(join(root, path), contents);
  return { distRoot: pathToFileURL(`${root}/`), entrypoints: ['index.html', 'profile.html'] };
}

for (const branch of ['main', 'develop']) {
  test(`${branch} shipped themes preserve public choices and fail-closed ownership`, async (t) => {
    const artifact = await fixture(t);
    assert.equal(await verifyThemeArtifacts({
      ...artifact, environment: { CF_PAGES: '1', CF_PAGES_BRANCH: branch },
    }), 2);
  });

  test(`${branch} fails when any route compiles with Dominion Night disabled`, async (t) => {
    const artifact = await fixture(t, { 'profile.html': html('false') });
    await assert.rejects(verifyThemeArtifacts({
      ...artifact, environment: { CF_PAGES: '1', CF_PAGES_BRANCH: branch },
    }), /profile.html: Dominion Night must be release-enabled/);
  });
}

test('noncanonical builds may explicitly exercise the release-disabled state', async (t) => {
  const artifact = await fixture(t, { 'index.html': html('false'), 'profile.html': html('false') });
  assert.equal(await verifyThemeArtifacts({ ...artifact, environment: {} }), 2);
});

test('the artifact must contain every registered production entry point', async (t) => {
  const artifact = await fixture(t);
  await assert.rejects(verifyThemeArtifacts({
    ...artifact, entrypoints: [...artifact.entrypoints, 'missing.html'], environment: {},
  }), { code: 'ENOENT' });
});

for (const [name, overrides, message] of [
  ['absent bootstrap', { 'profile.html': '<link rel="stylesheet" href="./theme.css">' }, /must load one theme bootstrap/],
  ['missing CSS', { 'theme.css': ':root{--text:#fff}' }, /missing the Dominion Night profile/],
  ['unlinked CSS', { 'profile.html': html().replace(/<link[^>]+>/, '') }, /missing the Dominion Night profile/],
  ['incomplete profile', { 'theme.css': ':root[data-theme="dominion-night"]{--background:#000}' }, /theme profile lacks --surface/],
  ['disabled registry', { 'theme-bootstrap.js': source.replace('enabled: dominionNightEnabled', 'enabled: false') }, /release availability differs/],
  ['removed entitlement gate', { 'theme-bootstrap.js': source.replace('requiresEntitlement: true', 'requiresEntitlement: false') }, /ownership is required/],
  ['ownership bypass', { 'theme-bootstrap.js': source.replace('entitledThemeIds[themeId] === true', 'true') }, /unverified owner/],
  ['deferred bootstrap', { 'profile.html': html().replace('<script ', '<script defer ') }, /bootstrap must run before paint/],
  ['late bootstrap', { 'profile.html': `<link rel="stylesheet" href="./theme.css">${html()}` }, /bootstrap must precede stylesheets/],
]) {
  test(`artifact verification rejects ${name}`, async (t) => {
    const artifact = await fixture(t, overrides);
    await assert.rejects(verifyThemeArtifacts({ ...artifact, environment: {} }), message);
  });
}

test('both release workflows explicitly enable the theme without enabling unrelated gates', async () => {
  for (const path of ['deploy.yml', 'cloudflare-preview.yml']) {
    const workflow = await readFile(new URL(`../../.github/workflows/${path}`, import.meta.url), 'utf8');
    assert.match(workflow, /VITE_ENABLE_DOMINION_NIGHT_THEME: "true"/);
    assert.match(workflow, /VITE_ENABLE_GROUP_INTEGRATIONS: "false"/);
    assert.match(workflow, /VITE_ENABLE_BILLING: "false"/);
    assert.match(workflow, /VITE_ENABLE_PUBLIC_SIGNUP: "false"/);
  }
});
