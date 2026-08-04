import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const productCss = read('../assets/product.css');
const communityCss = read('../assets/community.css');
const stylesCss = read('../assets/styles.css');
const dominionNightCss = read('../assets/dominion-night.css');

function ruleBody(css, selectorPattern) {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule matching ${selectorPattern}`);
  return match[1];
}

function variablesFor(css, selectorPattern) {
  const body = ruleBody(css, selectorPattern);
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]),
  );
}

function resolveHex(variables, token, seen = new Set()) {
  assert.ok(!seen.has(token), `Circular color token ${token}`);
  seen.add(token);
  const value = variables[token];
  assert.ok(value, `Missing color token ${token}`);
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const reference = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  assert.ok(reference, `${token} must resolve to a six-digit color for contrast coverage`);
  return resolveHex(variables, reference, seen);
}

function mixHex(foreground, background, amount) {
  const channels = (hex) => hex.slice(1).match(/.{2}/g).map((value) => Number.parseInt(value, 16));
  const foregroundChannels = channels(foreground);
  const backgroundChannels = channels(background);
  return '#' + foregroundChannels.map((value, index) => (
    Math.round(value * amount + backgroundChannels[index] * (1 - amount))
      .toString(16)
      .padStart(2, '0')
  )).join('');
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

describe('shared branded secondary controls', () => {
  test('gives secondary links and buttons the same branded base treatment', () => {
    const base = ruleBody(productCss, '\\}\\s*\\.secondary,\\s*\\.secondary-button');

    assert.match(
      productCss,
      /\.cta-button,\s*\.secondary,\s*\.secondary-button\s*\{[^}]*min-height:\s*52px/,
    );
    assert.match(base, /padding:\s*12px 18px/);
    assert.match(base, /border-radius:\s*16px/);
    assert.match(base, /var\(--button-secondary-background\)/);
    assert.match(base, /var\(--button-secondary-text\)/);
    assert.match(base, /font-weight:\s*900/);
    assert.match(base, /transition:/);
  });

  test('keeps compact, destructive, interactive, and disabled states deliberate', () => {
    const compact = ruleBody(productCss, '\\.secondary\\.compact');
    const destructive = ruleBody(productCss, '\\.secondary\\.destructive');

    assert.match(compact, /min-height:\s*44px/);
    assert.match(destructive, /var\(--button-danger-background\)/);
    assert.match(destructive, /color:\s*var\(--button-danger-text\)/);
    assert.match(productCss, /\.secondary:not\(:disabled\):not\(\[aria-disabled="true"\]\):hover/);
    assert.match(productCss, /\.secondary:not\(:disabled\):not\(\[aria-disabled="true"\]\):active/);
    assert.match(productCss, /\.secondary:disabled,\s*\.secondary\[aria-disabled="true"\]/);
  });

  test('keeps destructive normal and hover text above AA contrast in every theme', () => {
    const base = variablesFor(stylesCss, ':root');
    const light = { ...base, ...variablesFor(stylesCss, ':root\\[data-theme="light"\\]') };
    const night = variablesFor(dominionNightCss, ':root\\[data-theme="dominion-night"\\]');
    const palettes = { dark: base, light, 'dominion-night': night };

    assert.match(communityCss, /\.community-shell button\.destructive\s*\{[^}]*color:\s*var\(--button-danger-text\)/s);
    assert.match(communityCss, /button\.destructive:hover\s*\{[^}]*var\(--danger[^)]*\) 22%/s);
    assert.match(productCss, /\.secondary\.destructive[^}]*color:\s*var\(--button-danger-text\)/s);

    for (const [theme, variables] of Object.entries(palettes)) {
      const foreground = resolveHex(variables, '--button-danger-text');
      const danger = resolveHex(variables, '--danger');
      const surface = resolveHex(variables, '--surface');
      const elevated = resolveHex(variables, '--surface-elevated');
      const backgrounds = {
        'shared normal': mixHex(danger, elevated, 0.14),
        'shared hover': mixHex(danger, elevated, 0.20),
        'community normal': mixHex(danger, surface, 0.13),
        'community hover': mixHex(danger, surface, 0.22),
      };

      for (const [state, background] of Object.entries(backgrounds)) {
        assert.ok(
          contrast(foreground, background) >= 4.5,
          `${theme} ${state} destructive text must meet AA contrast`,
        );
      }
    }
  });

  test('covers the production Invite, Community, Profile, and share-flow consumers', () => {
    const invite = read('../../invite.html');
    const community = read('../../community.html');
    const profile = read('../../profile.html');
    const shareComposer = read('./share-composer.js');

    [invite, community, profile].forEach((html) => {
      assert.match(html, /\.\/src\/assets\/product\.css/);
    });
    assert.match(invite, /class="secondary" id="leaveInviteLink"/);
    assert.match(community, /class="secondary crew-training-launch"/);
    assert.match(community, /class="secondary destructive"/);
    assert.match(profile, /class="secondary" id="resetPreviewChallengeButton"/);
    assert.match(shareComposer, /'button', 'secondary', 'Copy share link'/);
  });
});

describe('Intentional Walk resource action typography', () => {
  test('preserves the shared resource-link weight for a button-backed action', () => {
    const resourceLink = ruleBody(productCss, '\\.action-resource-link');
    const buttonResourceLink = ruleBody(productCss, '\\.action-resource-link:is\\(button\\)');
    const controller = read('./daily-standard-page.js');

    assert.match(resourceLink, /font-weight:\s*900/);
    assert.doesNotMatch(buttonResourceLink, /(^|;)\s*font\s*:/);
    assert.match(buttonResourceLink, /font-family:\s*inherit/);
    assert.match(buttonResourceLink, /text-align:\s*left/);
    assert.match(controller, /reminder\.className = 'action-resource-link'/);
    assert.match(controller, /reminder\.textContent = 'Set walk alarm ↗'/);
  });
});
