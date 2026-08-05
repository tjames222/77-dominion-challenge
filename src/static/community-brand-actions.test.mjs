import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { groupIntegrationsEnabled } from './group-integration-launch.mjs';

const html = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/community.css', import.meta.url), 'utf8');
const javascript = readFileSync(new URL('./community.js', import.meta.url), 'utf8');
const inviteDialog = readFileSync(new URL('./crew-invite-dialog.js', import.meta.url), 'utf8');
const inviteCss = readFileSync(new URL('../assets/crew-invite.css', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

describe('branded Community actions', () => {
  test('keeps Invite People branded while opening its dedicated secure dialog', () => {
    assert.match(
      html,
      /class="invite-people-button"[\s\S]*?id="copyInviteButton"[\s\S]*?Invite People/,
    );
    assert.doesNotMatch(html, /id="copyInviteButton"[\s\S]{0,180}data-share-composer/);
    assert.match(javascript, /initCrewInviteDialog\(\{ getCrew: activeCrew \}\)/);
    assert.match(inviteDialog, /title: 'Invite People'/);
    assert.match(inviteDialog, /Link, Code, or QR/);
    assert.match(html, /class="invite-people-icon" aria-hidden="true">\+</);
    assert.match(css, /\.invite-people-button\s*\{[\s\S]*?min-height:\s*54px/);
    assert.match(css, /\.invite-people-button:hover:not\(:disabled\)/);
    assert.match(css, /\.invite-people-button:active:not\(:disabled\)/);
    assert.match(css, /\.invite-people-button:focus-visible/);
    assert.match(css, /\.invite-people-button\[aria-busy="true"\]/);
    assert.match(css, /var\(--button-primary-background\)/);
    assert.match(inviteCss, /\.crew-invite-tabs/);
    assert.match(inviteCss, /min-height:\s*44px/);
    assert.doesNotMatch(css, /^button\s*\{[^}]*linear-gradient/m);
  });

  test('uses recognizable local provider marks and complete lifecycle states', () => {
    assert.match(html, /provider-mark-slack[\s\S]*?<svg[\s\S]*?Connect Slack/);
    assert.match(html, /provider-mark-discord[\s\S]*?<svg[\s\S]*?Connect Discord/);
    assert.match(javascript, /providerMark\(provider\)/);
    assert.match(javascript, /Test \$\{providerName\}/);
    assert.match(javascript, /Reconnect \$\{providerName\}/);
    assert.match(javascript, /provider-disconnect[\s\S]*?Disconnect/);
    assert.match(javascript, /data-integration-status/);
    assert.match(javascript, /setAttribute\('aria-busy', 'true'\)/);
    assert.match(css, /\.provider-button\s*\{[\s\S]*?min-height:\s*48px/);
    assert.match(css, /\.provider-button\.provider-secondary\s*\{[\s\S]*?min-height:\s*44px/);
    assert.match(css, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /data-integration-status="active"/);
    assert.match(css, /data-integration-status="reconnect_required"/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.provider-button/);
  });

  test('fails closed unless the provider rollout flag is explicitly enabled', () => {
    assert.equal(groupIntegrationsEnabled(undefined), false);
    assert.equal(groupIntegrationsEnabled('false'), false);
    assert.equal(groupIntegrationsEnabled(' true '), true);
    assert.equal(groupIntegrationsEnabled(true), true);
    assert.match(envExample, /VITE_ENABLE_GROUP_INTEGRATIONS=false/);
    assert.match(html, /id="crewIntegrationsCard"[^>]+hidden/);
    assert.match(javascript, /GROUP_INTEGRATIONS_ENABLED = groupIntegrationsEnabled/);
    assert.match(javascript, /integrationsCard\.hidden = !crew \|\| !GROUP_INTEGRATIONS_ENABLED/);
    assert.match(javascript, /if \(!GROUP_INTEGRATIONS_ENABLED \|\| !crew\)/);
    assert.match(javascript, /if \(!GROUP_INTEGRATIONS_ENABLED\) return;[\s\S]*?data-connect-provider/);
    assert.match(javascript, /window\.history\.replaceState[\s\S]*?if \(!GROUP_INTEGRATIONS_ENABLED\)/);
  });
});
