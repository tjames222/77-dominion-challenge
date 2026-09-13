import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

const limits = { 480: 30_000, 768: 60_000, 1200: 110_000, 1536: 175_000 };

export function verifyHeroBytes(bytes, entry) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Hero byte/hash mismatch: ${entry.file}`);
  if (!limits[entry.width] || bytes.length > limits[entry.width]) throw new Error(`Hero byte budget exceeded: ${entry.file}`);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Invalid hero WebP.');
  let dimensions;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunk = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) throw new Error('Truncated hero WebP.');
    if (chunk === 'VP8X' && size >= 10) {
      dimensions = [bytes.readUIntLE(offset + 12, 3) + 1, bytes.readUIntLE(offset + 15, 3) + 1];
      break;
    }
    if (chunk === 'VP8 ' && size >= 10) {
      dimensions = [bytes.readUInt16LE(offset + 14) & 0x3fff, bytes.readUInt16LE(offset + 16) & 0x3fff];
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!dimensions || dimensions[0] !== entry.width || dimensions[1] !== entry.height || entry.width / entry.height !== 1.5) {
    throw new Error(`Hero intrinsic dimensions changed: ${entry.file}`);
  }
}

export async function verifyHeroArtwork(distRoot) {
  const manifest = JSON.parse(await readFile(new URL('../src/assets/hero/hero-artwork.json', import.meta.url), 'utf8'));
  const assetNames = await readdir(new URL('assets/', distRoot));
  const html = await readFile(new URL('index.html', distRoot), 'utf8');
  if (manifest.variants.length !== 8) throw new Error('Expected four responsive widths for each hero theme.');
  for (const entry of manifest.variants) {
    const stem = entry.file.replace('.webp', '');
    const matches = assetNames.filter((name) => new RegExp(`^${stem}-[\\w-]+\\.webp$`).test(name));
    if (matches.length !== 1) throw new Error(`Expected one hashed hero asset: ${entry.file}`);
    await verifyHeroBytes(await readFile(new URL(`assets/${matches[0]}`, distRoot)), entry);
    if (!html.includes(`/assets/${matches[0]} ${entry.width}w`)) throw new Error(`Missing responsive hero HTML reference: ${entry.file}`);
  }
  for (const original of Object.values(manifest.originals)) {
    if (!html.includes(`src="${original.url}"`)) throw new Error('Original hero fallback was removed.');
  }
  return manifest.variants.length;
}
