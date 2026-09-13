import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { htmlAssetReferences, staticModuleReferences } from '../../scripts/measure-frontend-bundles.mjs';
import { communityPreviewMessage, renderInitialPreviewFeedback } from './preview-feedback.mjs';
import { verifyHeroBytes } from '../../scripts/verify-hero-artwork.mjs';
import { checkFrontendPerformance } from '../../scripts/check-frontend-performance.mjs';

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

test('responsive artwork preserves pinned bytes, dimensions, budgets and original fallback content', () => {
  const manifest = JSON.parse(readFileSync(new URL('../assets/hero/hero-artwork.json', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.equal(manifest.encoder, 'cwebp 1.6.0');
  assert.equal(manifest.variants.length, 8);
  for (const variant of ['dark', 'light']) {
    assert.deepEqual(manifest.variants.filter((entry) => entry.variant === variant).map((entry) => entry.width), [480, 768, 1200, 1536]);
    assert.ok(html.includes(`src="${manifest.originals[variant].url}"`));
  }
  for (const entry of manifest.variants) {
    const bytes = readFileSync(new URL(`../assets/hero/${entry.file}`, import.meta.url));
    verifyHeroBytes(bytes, entry);
    assert.throws(() => verifyHeroBytes(bytes, { ...entry, sha256: 'wrong' }), /hash mismatch/);
    assert.throws(() => verifyHeroBytes(bytes, { ...entry, height: entry.height + 1 }), /dimensions changed/);
    assert.ok(html.includes(`${entry.file} ${entry.width}w`));
  }
  assert.equal((html.match(/width="1536" height="1024" loading="lazy"/g) || []).length, 2);
  assert.equal((html.match(/<source type="image\/webp"/g) || []).length, 2);
});

test('training presentation and its stylesheet belong to a deferred graph', () => {
  const runtime = readFileSync(new URL('./site-training-runtime.mjs', import.meta.url), 'utf8');
  const loader = readFileSync(new URL('./site-training-ui-loader.mjs', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('./site-training-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /from ['"]\.\/site-training-coachmark\.mjs/);
  assert.match(loader, /import\('\.\/site-training-ui\.js'\)/);
  assert.match(entry, /import '\.\.\/assets\/site-training\.css';/);
});

test('interim graph budgets prevent regressions without reporting incomplete JS targets as achieved', () => {
  const budgets = { maximumSingleJsChunkGzip: 100, routes: {
    main: { maximumJsGzip: 100, targetJsGzip: 60, maximumCssGzip: 30, maximumInitialRequests: 2 },
  } };
  const measured = { routes: { main: { js: { gzip: 80 }, css: { gzip: 20 }, requestCount: 2, assets: ['assets/main-Abcd.js'] } }, assets: [] };
  assert.deepEqual(checkFrontendPerformance(measured, budgets), {
    pass: true, targetsMet: false, violations: [], remainingTargets: ['main: JS 80 still exceeds completion target 60'],
  });
  assert.equal(checkFrontendPerformance(measured, budgets, { requireTargets: true }).pass, false);
  measured.routes.main.assets.push('assets/share-composer-A1234567.js');
  measured.routes.main.js.gzip = 101;
  measured.routes.main.css.gzip = 31;
  measured.routes.main.requestCount = 3;
  measured.assets.push({ path: 'assets/lazy-A1234567.js', gzip: 101 });
  assert.equal(checkFrontendPerformance(measured, budgets).violations.length, 5);
});
