import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const api = read('./api.js');
const composer = read('./share-composer.js');
const css = read('../assets/share-composer.css');
const dashboard = read('../../dashboard.html');
const rewards = read('../../badges-rewards.html');
const community = read('../../community.html');
const communityJs = read('./community.js');

describe('sharing composer browser integration', () => {
  test('uses the authoritative snapshot and lifetime reward APIs', () => {
    assert.match(api, /functions\.invoke\(name, \{ body \}\)/);
    assert.match(api, /invokeSupabaseAction\('share-snapshot', \{ action: 'preview', kind \}\)/);
    assert.match(api, /invokeSupabaseAction\('share-snapshot', \{ action: 'create', kind \}\)/);
    assert.match(api, /client\.rpc\('create_sharing_reward_intent'/);
    assert.match(api, /client\.rpc\('complete_sharing_reward'/);
  });

  test('loads one shared accessible composer from progress, streak, general, and invite entries', () => {
    [dashboard, rewards, community].forEach((html) => {
      assert.match(html, /src\/assets\/share-composer\.css/);
      assert.match(html, /src\/static\/share-composer\.js/);
    });
    assert.match(dashboard, /data-share-kind="streak"/);
    assert.match(dashboard, /data-share-kind="progress"/);
    assert.match(dashboard, /data-share-kind="general"/);
    assert.match(community, /data-share-kind="invite"/);
    assert.match(composer, /createDialog\(\{/);
    assert.match(composer, /Choose what to share/);
    assert.match(composer, /input\.type = 'radio'/);
    assert.match(composer, /status\.setAttribute\('aria-live', 'polite'\)/);
  });

  test('retires the direct invite-copy path in favor of explicit composer actions', () => {
    assert.doesNotMatch(communityJs, /getOrCreateCrewInvite/);
    assert.doesNotMatch(communityJs, /navigator\.clipboard/);
    assert.match(composer, /executeInviteShare/);
    assert.match(composer, /reward unlocks after another person joins/);
  });

  test('supports keyboard focus, narrow screens, and reduced ambiguity between methods', () => {
    assert.match(css, /:focus-visible/);
    assert.match(css, /@media \(max-width: 540px\)/);
    assert.match(composer, /data-share-method/);
    assert.match(composer, /Share from this device/);
    assert.match(composer, /Copy share link/);
  });
});
