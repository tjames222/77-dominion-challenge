import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_ENTRYPOINTS, RETIRED_ROUTE_REDIRECTS } from '../../app-entrypoints.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('production MPA entry points', () => {
  it('declares every root HTML page exactly once', async () => {
    const rootFiles = await readdir(repositoryRoot);
    const htmlFiles = rootFiles.filter((file) => file.endsWith('.html')).sort();
    const declaredFiles = [
      ...Object.values(PRODUCTION_ENTRYPOINTS),
      ...RETIRED_ROUTE_REDIRECTS,
    ].sort();

    assert.deepEqual(declaredFiles, htmlFiles);
    assert.equal(new Set(declaredFiles).size, declaredFiles.length);
  });

  it('connects each page to an active static module', async () => {
    for (const htmlFile of Object.values(PRODUCTION_ENTRYPOINTS)) {
      const html = await readFile(new URL(`../../${htmlFile}`, import.meta.url), 'utf8');
      const moduleSources = [...html.matchAll(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/g)]
        .map((match) => match[1]);

      assert.ok(moduleSources.length > 0, `${htmlFile} must load a module script`);
      assert.doesNotMatch(html, /src\/main\.ts|\.vue(?:["'])/);

      for (const source of moduleSources) {
        assert.match(source, /^\.\/src\/static\//, `${htmlFile} uses an unexpected module: ${source}`);
        await readFile(new URL(`../../${source.replace(/^\.\//, '')}`, import.meta.url));
      }
    }
  });

  it('keeps retired routes outside the active Vite entry-point map', () => {
    const activeFiles = new Set(Object.values(PRODUCTION_ENTRYPOINTS));

    for (const redirect of RETIRED_ROUTE_REDIRECTS) {
      assert.equal(activeFiles.has(redirect), false);
    }
  });
});
