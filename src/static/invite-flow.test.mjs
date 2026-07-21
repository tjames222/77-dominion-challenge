import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVITE_CONTINUATION_STORAGE_KEY,
  buildInviteAuthHref,
  captureInviteSecret,
  cleanInviteLocation,
  clearInviteContinuation,
  getStoredInviteContinuation,
  inviteStatusContent,
  isInviteReturnPath,
  readInviteSecret,
  storeInviteContinuation,
} from './invite-flow.mjs';

test('fragment invites take precedence and are removed before continuation work', () => {
  const calls = [];
  const fakeWindow = {
    location: {
      pathname: '/invite.html',
      search: '?campaign=crew',
      hash: '#invite=fragment-secret-12345',
    },
    history: { replaceState: (...args) => calls.push(args) },
  };

  assert.deepEqual(captureInviteSecret(fakeWindow), {
    secret: 'fragment-secret-12345',
    source: 'fragment',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], '/invite.html?campaign=crew');
  assert.equal(calls[0][2].includes('fragment-secret'), false);
});

test('legacy query invites are accepted only for migration and stripped immediately', () => {
  const location = {
    pathname: '/invite.html',
    search: '?invite=legacy-secret-12345&source=old-link',
    hash: '',
  };
  assert.deepEqual(readInviteSecret(location), {
    secret: 'legacy-secret-12345',
    source: 'legacy-query',
  });
  assert.equal(cleanInviteLocation(location), '/invite.html?source=old-link');
});

test('short, malformed, and script-like secrets are ignored', () => {
  assert.equal(readInviteSecret({ hash: '#invite=short' }).secret, '');
  assert.equal(readInviteSecret({ hash: '#invite=%3Cscript%3Ealert(1)%3C%2Fscript%3E' }).secret, '');
  assert.equal(readInviteSecret({ hash: '#invite=valid_secret-token-123' }).secret, 'valid_secret-token-123');
});

test('auth continuation is fixed to the invite page and cannot carry secrets', () => {
  assert.equal(buildInviteAuthHref('login'), './login.html?returnTo=.%2Finvite.html');
  assert.equal(buildInviteAuthHref('register'), './register.html?returnTo=.%2Finvite.html');
  assert.equal(isInviteReturnPath('./invite.html'), true);
  assert.equal(isInviteReturnPath('./invite.html?invite=secret-secret-123'), false);
  assert.equal(isInviteReturnPath('https://evil.example/invite.html'), false);
  assert.equal(isInviteReturnPath('//evil.example/invite.html'), false);
});

test('continuations use session-style storage and reject invalid values', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  assert.equal(storeInviteContinuation(storage, 'valid-continuation-12345'), true);
  assert.equal(values.get(INVITE_CONTINUATION_STORAGE_KEY), 'valid-continuation-12345');
  assert.equal(getStoredInviteContinuation(storage), 'valid-continuation-12345');
  clearInviteContinuation(storage);
  assert.equal(getStoredInviteContinuation(storage), '');
  assert.equal(storeInviteContinuation(storage, 'bad'), false);
});

test('privacy-safe failure copy does not include private group or inviter data', () => {
  for (const status of ['invalid', 'expired', 'revoked', 'already_used', 'full', 'wrong_account']) {
    const content = inviteStatusContent(status, {
      groupName: 'Secret Group Name',
      inviterName: 'Private Person',
    });
    const combined = `${content.eyebrow} ${content.title} ${content.message}`;
    assert.equal(combined.includes('Secret Group Name'), false, status);
    assert.equal(combined.includes('Private Person'), false, status);
  }
});

test('ready and joined states name only the privacy-safe preview fields', () => {
  const ready = inviteStatusContent('ready', { groupName: 'Morning Crew', inviterName: 'Alex' });
  assert.match(ready.title, /Morning Crew/);
  assert.match(ready.message, /Alex/);
  const joined = inviteStatusContent('joined', { groupName: 'Morning Crew' });
  assert.match(joined.title, /Morning Crew/);
});
