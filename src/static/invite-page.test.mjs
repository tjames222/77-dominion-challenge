import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';

const inviteHtml = readFileSync(new URL('../../invite.html', import.meta.url), 'utf8');
const inviteCss = readFileSync(new URL('../assets/invite.css', import.meta.url), 'utf8');
const inviteJs = readFileSync(new URL('./invite.js', import.meta.url), 'utf8');
const communityJs = readFileSync(new URL('./community.js', import.meta.url), 'utf8');
const shareComposer = readFileSync(new URL('./share-composer.mjs', import.meta.url), 'utf8');
const apiJs = readFileSync(new URL('./api.js', import.meta.url), 'utf8');

describe('private-group invitation browser page', () => {
  test('is a dedicated no-referrer, non-indexed Vite entry', () => {
    assert.match(inviteHtml, /<meta name="referrer" content="no-referrer"\s*\/?>/);
    assert.match(inviteHtml, /<meta name="robots" content="noindex, nofollow"\s*\/?>/);
    assert.match(inviteHtml, /src="\.\/src\/static\/invite\.js"/);
    assert.equal(PRODUCTION_ENTRYPOINTS.invite, 'invite.html');
  });

  test('requires a distinct user gesture before confirmation', () => {
    assert.match(inviteHtml, /id="confirmInviteButton"[^>]*hidden/);
    assert.match(inviteJs, /\$\('confirmInviteButton'\)\?\.addEventListener\('click'/);
    const initialLoad = inviteJs.match(/async function loadInvite\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
    assert.equal(initialLoad.includes('confirmCrewInvite'), false, 'page hydration must never auto-confirm membership');
    assert.match(inviteHtml, /Opening this page never joins a group by itself\./);
  });

  test('creates new invitation links with a fragment instead of a query secret', () => {
    assert.doesNotMatch(communityJs, /searchParams\.set\(['"]invite/);
    assert.match(shareComposer, /new URL\('\.\/invite\.html'/);
    assert.match(shareComposer, /url\.hash = `invite=/);
    assert.doesNotMatch(shareComposer, /searchParams\.set\(['"]invite/);
  });

  test('refuses secret-bearing authentication return paths', () => {
    const sanitizer = apiJs.match(/export function sanitizeReturnTo\([\s\S]*?\n\}/)?.[0] || '';
    assert.match(sanitizer, /searchParams\.has\('invite'\)/);
    assert.match(sanitizer, /fragmentParams\.has\('invite'\)/);
    assert.match(sanitizer, /path === 'invite\.html'\) return '\.\/invite\.html'/);
  });

  test('offers login, registration, membership, retry, and safe-exit states', () => {
    for (const id of [
      'loginInviteLink',
      'registerInviteLink',
      'billingInviteLink',
      'retryInviteButton',
      'openGroupLink',
      'leaveInviteLink',
    ]) {
      assert.match(inviteHtml, new RegExp(`id=["']${id}["']`), `missing invite action: ${id}`);
    }
    assert.match(inviteHtml, /returnTo=\.%2Finvite\.html/);
    assert.equal(inviteJs.includes('console.'), false, 'invite failures must not log secret-bearing request context');
  });

  test('keeps confirmation controls usable on narrow screens', () => {
    assert.match(inviteCss, /@media \(max-width: 560px\)/);
    assert.match(inviteCss, /\.invite-actions[\s\S]*?flex-direction:\s*column/);
    assert.match(inviteCss, /\.invite-actions a,[\s\S]*?\.invite-actions button[\s\S]*?width:\s*100%/);
  });
});
