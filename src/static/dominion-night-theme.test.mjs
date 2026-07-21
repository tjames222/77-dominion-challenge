import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nightCss = await readFile(resolve(repoRoot, 'src/assets/dominion-night.css'), 'utf8');
const coreCss = await readFile(resolve(repoRoot, 'src/assets/styles.css'), 'utf8');
const bootstrap = await readFile(resolve(repoRoot, 'public/theme-bootstrap.js'), 'utf8');

const requiredTokens = [
  '--background',
  '--background-soft',
  '--surface',
  '--surface-elevated',
  '--glass',
  '--input',
  '--text',
  '--text-muted',
  '--text-disabled',
  '--text-inverse',
  '--border',
  '--divider',
  '--accent',
  '--accent-strong',
  '--focus-ring',
  '--selection-background',
  '--selection-text',
  '--link',
  '--success',
  '--warning',
  '--danger',
  '--info',
  '--shadow',
  '--glass',
  '--scrim',
  '--overlay-background',
  '--tooltip-background',
  '--tooltip-text',
  '--button-primary-background',
  '--button-primary-text',
  '--button-secondary-background',
  '--button-secondary-text',
  '--button-danger-background',
  '--button-danger-text',
  '--progress-track',
  '--progress-fill-start',
  '--progress-fill-end',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--streak-highlight',
  '--reward-accent',
  '--badge-accent',
];

function hexValue(token) {
  const match = nightCss.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `${token} must have an explicit six-digit color in Dominion Night`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

test('Dominion Night defines the complete semantic theme profile under its stable key', () => {
  assert.match(nightCss, /:root\[data-theme="dominion-night"\]\s*\{/);
  assert.match(nightCss, /color-scheme:\s*dark/);
  for (const token of requiredTokens) {
    assert.match(nightCss, new RegExp(`${token}:`), `${token} is missing`);
  }
  assert.match(bootstrap, /id:\s*'dominion-night'/);
  assert.match(bootstrap, /label:\s*'Dominion Night'/);
  assert.match(bootstrap, /themeColor:\s*'#071317'/);
});

test('palette contrast meets text, control, focus, and meaningful graphic thresholds', () => {
  const backgrounds = ['--background', '--background-soft', '--surface', '--surface-elevated', '--input'];
  for (const background of backgrounds) {
    assert.ok(
      contrast(hexValue('--text'), hexValue(background)) >= 4.5,
      `primary text must meet AA on ${background}`,
    );
    assert.ok(
      contrast(hexValue('--text-muted'), hexValue(background)) >= 4.5,
      `muted text must meet AA on ${background}`,
    );
  }

  assert.ok(contrast(hexValue('--button-primary-text'), hexValue('--button-primary-background')) >= 4.5);
  assert.ok(contrast(hexValue('--button-danger-text'), hexValue('--button-danger-background')) >= 4.5);

  for (const status of ['--success', '--warning', '--danger', '--info']) {
    assert.ok(
      contrast(hexValue(status), hexValue('--surface')) >= 4.5,
      `${status} must meet AA when used as status text on a surface`,
    );
  }

  assert.ok(
    contrast(hexValue('--focus-ring'), hexValue('--background')) >= 3,
    'focus ring must meet the non-text contrast threshold',
  );
  assert.ok(
    contrast(hexValue('--border'), hexValue('--background')) >= 3,
    'shared borders must remain perceivable against the page',
  );
});

test('existing Light and Dark foundation values remain intact', () => {
  assert.match(coreCss, /--background:\s*#000000/);
  assert.match(coreCss, /--surface:\s*#151515/);
  assert.match(coreCss, /--accent:\s*#d6ad54/);
  assert.match(coreCss, /:root\[data-theme="light"\][\s\S]*--background:\s*#fbfaf7/);
  assert.match(coreCss, /:root\[data-theme="light"\][\s\S]*--accent:\s*#b8892f/);
});

test('every current HTML route loads the profile after shared surface styles', async () => {
  const htmlFiles = (await readdir(repoRoot))
    .filter((file) => file.endsWith('.html') && file !== 'today-actions.html')
    .sort();
  assert.ok(htmlFiles.length >= 10);

  for (const file of htmlFiles) {
    const html = await readFile(resolve(repoRoot, file), 'utf8');
    const profileIndex = html.indexOf('./src/assets/dominion-night.css');
    const coreIndex = html.indexOf('./src/assets/styles.css');
    const productIndex = html.indexOf('./src/assets/product.css');
    assert.ok(profileIndex > coreIndex, `${file} must load Dominion Night after core CSS`);
    assert.ok(profileIndex > productIndex, `${file} must load Dominion Night after product CSS`);
  }
});

test('theme-aware images use the extensible marker and approved Dark fallback', async () => {
  const assetModule = await readFile(resolve(repoRoot, 'src/static/theme-assets.js'), 'utf8');
  assert.match(assetModule, /THEME_ASSET_SELECTOR = '\[data-theme-asset\]'/);
  assert.match(assetModule, /getAssetVariants\(theme\.id\)/);
  assert.doesNotMatch(assetModule, /theme\s*===\s*['"]dark['"]/);

  for (const file of ['index.html', 'dashboard.html', 'science.html']) {
    const html = await readFile(resolve(repoRoot, file), 'utf8');
    assert.match(html, /data-theme-asset/);
    assert.match(html, /data-theme-src-dark=/);
    assert.match(html, /data-theme-src-light=/);
  }
});

test('high-risk states include reduced-motion and forced-color protection', () => {
  assert.match(nightCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(nightCss, /@media \(forced-colors: active\)/);
  assert.match(nightCss, /\.challenge-card\.is-locked/);
  assert.match(nightCss, /\.challenge-card\.is-available/);
  assert.match(nightCss, /\.challenge-card\.is-active/);
  assert.match(nightCss, /\.challenge-card\.is-completed/);
  assert.match(nightCss, /\.reward-toast/);
  assert.match(nightCss, /\.leaderboard-row/);
  assert.match(nightCss, /\.skeleton/);
});
