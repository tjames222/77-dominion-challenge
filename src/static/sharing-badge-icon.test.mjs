import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const [dashboardSource, iconSource] = await Promise.all([
  readFile(new URL('./dashboard.js', import.meta.url), 'utf8'),
  readFile(new URL('../assets/icons.css', import.meta.url), 'utf8'),
]);

describe('Sharing badge icon', () => {
  it('maps the Sharing badge to its own code-native icon', () => {
    assert.match(dashboardSource, /'share'\]\s*\.includes\(icon\)/);
    assert.match(iconSource, /\.icon-share\s*\{\s*--icon:\s*url\(/);
  });
});
