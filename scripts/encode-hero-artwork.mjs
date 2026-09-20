// Mechanical encoding only: never crop, retouch, regenerate, or replace artwork.
// Download the two public originals to a temporary directory as hero-dark.png
// and hero-light.png, then run: node scripts/encode-hero-artwork.mjs <directory>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = process.argv[2];
if (!sourceDirectory) throw new Error('Pass the directory containing the two hash-pinned original PNGs.');
const encoder = process.env.HERO_CWEBP_BIN || 'cwebp';
if (execFileSync(encoder, ['-version'], { encoding: 'utf8' }).split('\n')[0].trim() !== '1.6.0') {
  throw new Error('Reproducible hero encoding requires cwebp 1.6.0.');
}
const originals = {
  dark: {
    url: 'https://pub-53499389187a4de4984349b4f9b36b74.r2.dev/5317DC26-DA71-4E5E-8964-01B9EAF033AF.png',
    sha256: 'd788671ce96e2cae297b4ca2905772d7e61139d81c3a96c3406a774506d1c222',
  },
  light: {
    url: 'https://pub-53499389187a4de4984349b4f9b36b74.r2.dev/photo_1783734046.5413918.png',
    sha256: '4bde2f579869cfc8cce604c1cd77d72d899e934985ca345b3e9db5ac15e70c91',
  },
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const outputDirectory = fileURLToPath(new URL('../src/assets/hero/', import.meta.url));
await mkdir(outputDirectory, { recursive: true });
const options = ['-q', '82', '-m', '6', '-sharp_yuv', '-metadata', 'icc'];
const manifest = { encoder: 'cwebp 1.6.0', options, originals: {}, variants: [] };
for (const [variant, original] of Object.entries(originals)) {
  const source = resolve(sourceDirectory, `hero-${variant}.png`);
  const bytes = await readFile(source);
  if (sha256(bytes) !== original.sha256) throw new Error(`${variant} original hash changed; review the source before encoding.`);
  if (bytes.readUInt32BE(16) !== 1536 || bytes.readUInt32BE(20) !== 1024) throw new Error('Unexpected original dimensions.');
  manifest.originals[variant] = { ...original, bytes: bytes.length, width: 1536, height: 1024 };
  for (const width of [480, 768, 1200, 1536]) {
    const file = `hero-${variant}-${width}.webp`;
    const output = resolve(outputDirectory, file);
    execFileSync(encoder, [...options, '-resize', String(width), '0', source, '-o', output], { stdio: 'pipe' });
    const encoded = await readFile(output);
    manifest.variants.push({ variant, file, width, height: width * 2 / 3, bytes: encoded.length, sha256: sha256(encoded) });
  }
}
await writeFile(resolve(outputDirectory, 'hero-artwork.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
