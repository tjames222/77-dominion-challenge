import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { PRODUCTION_ENTRYPOINTS } from '../app-entrypoints.mjs';

export function htmlAssetReferences(html) {
  return [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/g)]
    .map((match) => match[1]).filter((value) => /\.(?:js|css)(?:[?#]|$)/.test(value));
}

export function staticModuleReferences(source) {
  // Build output only: static imports and re-exports, deliberately not import().
  return [...source.matchAll(/(?:^|[;}])\s*(?:import|export)\s*(?:[^;]*?\bfrom\s*)?["']([^"']+)["']/g)]
    .map((match) => match[1]);
}

export async function measureFrontendBundles(directory = 'dist') {
  const root = resolve(directory);
  const files = new Map();
  async function readAsset(path) {
    const absolute = resolve(path);
    if (!absolute.startsWith(root + '/')) throw new Error('Bundle reference escaped dist.');
    const key = relative(root, absolute);
    if (files.has(key)) return files.get(key);
    const data = await readFile(absolute);
    const value = { path: key, raw: data.byteLength, gzip: gzipSync(data).byteLength,
      brotli: brotliCompressSync(data).byteLength, source: data.toString('utf8') };
    files.set(key, value);
    return value;
  }
  const routes = {};
  for (const [route, entry] of Object.entries(PRODUCTION_ENTRYPOINTS)) {
    const html = await readFile(resolve(root, entry), 'utf8');
    const pending = htmlAssetReferences(html).map((ref) => resolve(root, ref));
    const visited = new Set();
    while (pending.length) {
      const path = pending.pop();
      if (visited.has(path)) continue;
      visited.add(path);
      const asset = await readAsset(path);
      if (extname(path) === '.js') {
        for (const ref of staticModuleReferences(asset.source)) {
          if (!ref.startsWith('.')) throw new Error('Unexpected non-relative build import: ' + ref);
          pending.push(resolve(dirname(path), ref));
        }
      }
    }
    const assets = [...visited].map((path) => files.get(relative(root, path)));
    const totals = (extension) => assets.filter((asset) => asset.path.endsWith(extension))
      .reduce((sum, asset) => ({ raw: sum.raw + asset.raw, gzip: sum.gzip + asset.gzip, brotli: sum.brotli + asset.brotli }),
        { raw: 0, gzip: 0, brotli: 0 });
    routes[route] = { entry, js: totals('.js'), css: totals('.css'), requestCount: assets.length,
      assets: assets.map((asset) => asset.path).sort() };
  }
  // Include optional chunks too, so splitting cannot hide an unbounded payload.
  for (const name of await readdir(resolve(root, 'assets'))) {
    if (/\.(?:js|css|woff2)$/.test(name)) await readAsset(resolve(root, 'assets', name));
  }
  return { schemaVersion: 1, routes,
    assets: [...files.values()].map(({ source, ...asset }) => asset).sort((a, b) => b.gzip - a.gzip) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await measureFrontendBundles(process.argv[2] || fileURLToPath(new URL('../dist', import.meta.url))), null, 2));
}
