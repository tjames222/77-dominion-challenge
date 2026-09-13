import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { htmlAssetReferences, staticModuleReferences } from '../../scripts/measure-frontend-bundles.mjs';
import { communityPreviewMessage, renderInitialPreviewFeedback } from './preview-feedback.mjs';

test('bundle audit counts entry scripts, bootstrap, CSS and module preloads', () => {
  assert.deepEqual(htmlAssetReferences('<script src="./theme-bootstrap.js"></script><script type="module" src="./assets/page-Abc123.js"></script><link rel="modulepreload" href="./assets/shared-Def456.js"><link rel="stylesheet" href="./assets/app-123abc.css"><link rel="icon" href="/favicon.png">'),
    ['./theme-bootstrap.js', './assets/page-Abc123.js', './assets/shared-Def456.js', './assets/app-123abc.css']);
});

test('bundle audit includes static graph but excludes lazy imports', () => {
  assert.deepEqual(staticModuleReferences('import{a as b}from"./shared.js";import"./side-effect.js";export{c}from"./reexport.js";const lazy=()=>import("./optional.js");'),
    ['./shared.js', './side-effect.js', './reexport.js']);
});

test('only the active theme image is requested; switching retains the fallback contract', () => {
  const attributes = new Map([['src', '/dark.jpg'], ['data-theme-src-dark', '/dark.jpg'], ['data-theme-src-light', '/light.jpg']]);
  const changedSources = [];
  const image = { getAttribute: (name) => attributes.get(name), setAttribute: (name, value) => {
    attributes.set(name, value); changedSources.push(value);
  } };
  let active = 'dark';
  const source = readFileSync(new URL('./theme-assets.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  const scope = { getActiveTheme: () => active, getThemeDefinition: (id) => ({ id }),
    document: { querySelectorAll: () => [image] },
    window: { DominionThemeRuntime: { getAssetVariants: (id) => [id, 'dark'] } },
    Image: class { constructor() { throw new Error('Do not preload alternate theme assets.'); } } };
  runInNewContext(source + '\nsyncThemeAssets();', scope);
  assert.deepEqual(changedSources, []);
  active = 'light';
  runInNewContext('syncThemeAssets();', scope);
  assert.deepEqual(changedSources, ['/light.jpg']);
  active = 'dominion-night';
  runInNewContext('syncThemeAssets();', scope);
  assert.deepEqual(changedSources, ['/light.jpg', '/dark.jpg']);
});

test('cache policy separates immutable hashes from revalidated deploy pointers and private shares', () => {
  const headers = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8');
  assert.match(headers, /\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
  assert.match(headers, /\n\/\n\s+Cache-Control: no-cache/);
  assert.match(headers, /\n\/:page\n\s+Cache-Control: no-cache/);
  assert.doesNotMatch(headers, /(?:^|\n)\/\*\n\s+Cache-Control: (?:public|no-cache)/, 'Do not add conflicting blanket cache directives.');
  assert.match(headers, /\/images\/\*\n\s+Cache-Control: public, max-age=3600, must-revalidate/);
  assert.match(headers, /\/today-actions\n\s+Cache-Control: no-store/);
  const worker = readFileSync(new URL('../cloudflare/public-share-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /private, no-store/);
});

test('known preview feedback is present before first paint without adding a production banner', () => {
  const html = '<div class="community-feedback" id="communityFeedback" role="status" aria-live="polite"></div>';
  assert.equal(renderInitialPreviewFeedback(html), html);
  for (const integrationsEnabled of [false, true]) {
    const output = renderInitialPreviewFeedback(html, { mocksEnabled: true, integrationsEnabled });
    assert.match(output, /class="community-feedback active"/);
    assert.match(output, /role="status" aria-live="polite"/);
    assert.ok(output.includes(communityPreviewMessage(integrationsEnabled)));
    assert.equal(renderInitialPreviewFeedback(output, { mocksEnabled: true, integrationsEnabled }), output);
  }
  const config = readFileSync(new URL('../../vite.config.mjs', import.meta.url), 'utf8');
  assert.match(config, /mocksEnabled: env\.VITE_ENABLE_MOCKS === 'true'/);
});
