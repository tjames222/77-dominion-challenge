import { readFile, readdir, stat } from 'node:fs/promises';

const distRoot = new URL('../dist/', import.meta.url);
const assetNames = await readdir(new URL('assets/', distRoot));
const brandFonts = assetNames.filter((name) => /^InterVariable-[\w-]+\.woff2$/.test(name));

if (brandFonts.length !== 1) {
  throw new Error(`Expected one built Inter variable font, found ${brandFonts.length}.`);
}

const fontStats = await stat(new URL(`assets/${brandFonts[0]}`, distRoot));
if (fontStats.size < 100_000) {
  throw new Error(`Built Inter variable font is unexpectedly small (${fontStats.size} bytes).`);
}

const license = await readFile(new URL('fonts/Inter-LICENSE.txt', distRoot), 'utf8');
if (!license.includes('SIL OPEN FONT LICENSE Version 1.1')) {
  throw new Error('The production build is missing the Inter SIL Open Font License.');
}

console.log(`Verified production Inter font and license (${brandFonts[0]}).`);
