import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const api = read('./api.js');
const composer = read('./share-composer.js');
const composerModel = read('./share-composer.mjs');
const sharedHeader = read('./shared-header-actions.js');
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

  test('loads one shared accessible composer from header, rewards, streak, general, and invite entries', () => {
    [rewards, community].forEach((html) => {
      assert.match(html, /src\/assets\/share-composer\.css/);
      assert.match(html, /src\/static\/share-composer\.js/);
    });
    assert.match(dashboard, /src\/static\/menu\.js/);
    assert.doesNotMatch(dashboard, /src\/(?:assets|static)\/share-composer/);
    assert.match(sharedHeader, /ensureShareComposerStyles\(ownerDocument\)/);
    assert.match(sharedHeader, /initShareComposer\(ownerDocument\)/);
    assert.match(sharedHeader, /shareButton\.dataset\.shareKind = 'progress'/);
    assert.doesNotMatch(dashboard, /data-share-composer|data-share-kind=|Share my progress/);
    assert.match(rewards, /data-share-kind="progress"/);
    assert.match(community, /data-share-kind="invite"/);
    assert.match(composerModel, /kind: 'streak'/);
    assert.match(composerModel, /kind: 'general'/);
    assert.match(composer, /createDialog\(\{/);
    assert.match(composer, /Choose what to share/);
    assert.match(composer, /input\.type = 'radio'/);
    assert.match(composer, /status\.setAttribute\('aria-live', 'polite'\)/);
    assert.match(composer, /export function initShareComposer/);
    assert.match(composer, /shareComposerInstance\.bindTriggers\(triggers\)/);
    assert.match(sharedHeader, /initShareComposer\(ownerDocument\)/);
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

  test('force-closes and clears account-scoped state across authentication changes', () => {
    assert.match(composer, /shareComposerInstance\?\.reset\?\.\(reason\)/);
    assert.match(composer, /dialog\.close\('replaced'\)/);
    assert.match(composer, /previewRequest \+= 1/);
    assert.match(composer, /actionRequest \+= 1/);
    assert.match(composer, /managedCrews = \[\]/);
    assert.match(composer, /crewSelect\.replaceChildren\(\)/);
    assert.match(composer, /requestId === actionRequest/);
    assert.match(composer, /getLocalOrSessionUser\(\)/);
    assert.match(composer, /expectedUserId/);
    assert.match(composer, /shouldContinue/);
    assert.match(composer, /const nextManagedCrews/);
    assert.match(composer, /managedCrews = nextManagedCrews/);
    assert.match(composer, /const actionKind = currentKind/);
    assert.match(composer, /const actionCrew = actionKind === 'invite'/);
    assert.match(composer, /choices\.disabled = true/);
  });
});
