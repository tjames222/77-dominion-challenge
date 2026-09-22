import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';
import { build } from 'vite';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';
import { htmlAssetReferences } from '../../scripts/measure-frontend-bundles.mjs';
for (const mocks of [false, true]) test(`feedback stays outside every initial graph with mocks=${mocks}`, async () => {
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
  for (const entry of Object.values(PRODUCTION_ENTRYPOINTS)) {
    const visited = new Set(), pending = htmlAssetReferences(String(assets.get(entry).source)).map(path => posix.normalize(path));
    while (pending.length) { const name = pending.pop(); if (visited.has(name)) continue; visited.add(name); const asset = assets.get(name); if (asset?.type === 'chunk') pending.push(...asset.imports); }
    const chunks = [...visited].map(name => assets.get(name)).filter(asset => asset?.type === 'chunk');
    const modules = chunks.flatMap(asset => Object.keys(asset.modules));
    assert.equal(modules.filter(id => id.endsWith('/auth-runtime-core.mjs')).length, 1, `${entry} singleton`);
    for (const name of ['client', 'contract', 'context', 'dialog', 'widget']) assert.ok(!modules.some(id => id.endsWith(`/feedback-${name}.mjs`)), `${entry} excludes feedback-${name}`);
    for (const name of visited) if (name.endsWith('.css')) assert.doesNotMatch(String(assets.get(name)?.source), /\.feedback-(?:widget|form|actions)/, `${entry} excludes feedback styles`);
  }
});
