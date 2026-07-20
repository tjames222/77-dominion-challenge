import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const html = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
const javascript = readFileSync(new URL('./community.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/community.css', import.meta.url), 'utf8');

describe('private-group provider connections', () => {
  it('explains the external-only conversation model and exposes both supported providers', () => {
    assert.match(html, /Conversations and replies stay in Slack or Discord/);
    assert.match(html, /data-connect-provider="slack"/);
    assert.match(html, /data-connect-provider="discord"/);
    assert.match(html, /id="integrationDestinationList"[^>]+aria-live="polite"/);
    assert.match(html, /for="integrationChannelSelect"/);
  });

  it('shows members sanitized status while keeping management actions leader-only', () => {
    assert.match(javascript, /const canManage = isCrewLeader\(\)/);
    assert.match(javascript, /destination\.canManage/);
    assert.match(javascript, /Connected/);
    assert.match(javascript, /Needs attention/);
    assert.match(javascript, /Disconnected/);
    assert.match(javascript, /data-test-integration/);
    assert.match(javascript, /data-reconnect-provider/);
    assert.match(javascript, /data-disconnect-integration/);
  });

  it('takes the one-time setup token from the fragment and immediately removes it from the address', () => {
    assert.match(javascript, /window\.location\.hash\.slice\(1\)/);
    assert.match(javascript, /params\.get\('integration-setup'\)/);
    assert.match(javascript, /window\.history\.replaceState/);
    assert.doesNotMatch(javascript, /localStorage\.setItem\([^\n]*integration-setup/);
  });

  it('allows redirects only to the official Slack and Discord authorization hosts', () => {
    assert.match(javascript, /\['slack\.com', 'discord\.com'\]\.includes\(authorization\.hostname\)/);
    assert.match(javascript, /window\.location\.assign\(authorization\.toString\(\)\)/);
  });

  it('uses the fixed server action without accepting arbitrary webhook URLs', () => {
    assert.match(api, /invokeSupabaseAction\('group-integrations', \{ action, \.\.\.values \}\)/);
    assert.doesNotMatch(html, /webhook/i);
    assert.doesNotMatch(javascript, /webhookUrl|destinationUrl/);
  });

  it('keeps controls usable on narrow screens and derives both themes from shared tokens', () => {
    assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.integration-destination/);
    assert.match(css, /min-height: 44px/);
    assert.match(css, /var\(--surface\)/);
    assert.match(css, /var\(--text-muted\)/);
  });
});
