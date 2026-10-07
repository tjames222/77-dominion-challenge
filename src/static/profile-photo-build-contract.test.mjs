import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';
import { build } from 'vite';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';
import { htmlAssetReferences } from '../../scripts/measure-frontend-bundles.mjs';
import { resolveTrainingModulePreloads } from '../../vite.config.mjs';

test('photo reload recovery omits only the optional encoder JS preload', () => {
  const target = 'assets/profile-photo-preparation-hash.js';
  const dependencies = [target, 'assets/auth-shared-hash.js', 'assets/profile-photo-preparation-hash.css'];
  assert.deepEqual(resolveTrainingModulePreloads(target, dependencies, { hostType: 'js' }), dependencies.slice(1));
  assert.equal(dependencies.length, 3);
  assert.equal(resolveTrainingModulePreloads(target, dependencies, { hostType: 'html' }), dependencies);
  for (const other of ['assets/profilePage-hash.js', 'assets/profile-photo-preparation-loader-hash.js']) {
    assert.equal(resolveTrainingModulePreloads(other, dependencies, { hostType: 'js' }), dependencies);
  }
});

for (const mocks of [false, true]) test(`photo encoder is absent from all 29 initial graphs with mocks=${mocks}`, async () => {
  const artifact = await build({ root: fileURLToPath(new URL('../..', import.meta.url)),
    configFile: fileURLToPath(new URL('../../vite.config.mjs', import.meta.url)), logLevel: 'silent',
    define: { __DOMINION_BUILD_SHA__: JSON.stringify('a'.repeat(40)),
      'import.meta.env.VITE_ENABLE_MOCKS': JSON.stringify(String(mocks)),
      'import.meta.env.VITE_ENABLE_PRODUCTION_CONNECTIONS': JSON.stringify(String(!mocks)),
      'import.meta.env.VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS': JSON.stringify('false'),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(mocks ? '' : 'https://mimolwojppbtsbvtqwpo.supabase.co'),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(mocks ? '' : 'sb_publishable_synthetic_build_only'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
    }, build: { write: false } });
  const assets = new Map(artifact.output.map(asset => [asset.fileName, asset]));
  const processingChunks = artifact.output.filter(asset => asset.type === 'chunk'
    && Object.keys(asset.modules).some(id => id.endsWith('/profile-photo-preparation.mjs')));
  assert.equal(processingChunks.length, 1, 'one reusable deferred encoder');
  assert.match(processingChunks[0].fileName, /profile-photo-preparation-/);
  for (const entry of Object.values(PRODUCTION_ENTRYPOINTS)) {
    const visited = new Set();
    const pending = htmlAssetReferences(String(assets.get(entry).source)).map(path => posix.normalize(path));
    while (pending.length) {
      const name = pending.pop();
      if (visited.has(name)) continue;
      visited.add(name);
      const asset = assets.get(name);
      if (asset?.type === 'chunk') pending.push(...asset.imports);
    }
    const modules = [...visited].map(name => assets.get(name)).filter(asset => asset?.type === 'chunk').flatMap(asset => Object.keys(asset.modules));
    assert.ok(!modules.some(id => id.endsWith('/profile-photo-preparation.mjs')), `${entry} excludes decoding/canvas/encoding`);
    assert.equal(modules.filter(id => id.endsWith('/auth-runtime-core.mjs')).length,
      entry === 'early-access-invite.html' ? 0 : 1, `${entry} keeps its existing Auth boundary`);
  }
});
