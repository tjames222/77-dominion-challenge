import { readFile } from 'node:fs/promises';
import { verifyHeroBytes } from './verify-hero-artwork.mjs';

const base = new URL(process.argv[2]);
const sha = process.argv[3];
if (base.protocol !== 'https:' || !/^[a-f0-9]{8}\.77-dominion-live\.pages\.dev$/.test(base.hostname)
  || base.pathname !== '/' || base.search || base.hash || !/^[a-f0-9]{40}$/.test(sha || '')) {
  throw new Error('Use a verified immutable preview of the approved project and its exact source SHA.');
}
const manifest = JSON.parse(await readFile(new URL('../src/assets/hero/hero-artwork.json', import.meta.url), 'utf8'));
const response = await fetch(base);
if (!response.ok || response.headers.get('cache-control') !== 'no-cache') throw new Error('Preview HTML must revalidate.');
const html = await response.text();
const verified = [];
for (const entry of manifest.variants) {
  const stem = entry.file.replace('.webp', '');
  const matches = [...html.matchAll(new RegExp(`(/assets/${stem}-[\\w-]+\\.webp) ${entry.width}w`, 'g'))];
  if (matches.length !== 1) throw new Error(`Missing unique deployed srcset candidate: ${entry.file}`);
  const path = matches[0][1];
  const asset = await fetch(new URL(path, base));
  if (!asset.ok || asset.headers.get('content-type') !== 'image/webp'
    || asset.headers.get('cache-control') !== 'public, max-age=31536000, immutable') {
    throw new Error(`Unexpected deployed image status, type or caching: ${path}`);
  }
  const bytes = Buffer.from(await asset.arrayBuffer());
  verifyHeroBytes(bytes, entry);
  verified.push({ path, bytes: bytes.length, sha256: entry.sha256, cacheControl: asset.headers.get('cache-control') });
}
console.log(JSON.stringify({ baseURL: base.href, verifiedSourceSha: sha, htmlCacheControl: response.headers.get('cache-control'), verified }, null, 2));
