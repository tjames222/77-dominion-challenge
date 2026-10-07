import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createProfilePhotoPreparationLoader, PHOTO_PREPARATION_RELOAD_MESSAGE } from './profile-photo-preparation-loader.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('photo preparation is interaction-only and concurrent loads share code, not photo state', async () => {
  const module = { prepareProfilePhoto: () => {} };
  const gate = deferred();
  let loads = 0;
  const load = createProfilePhotoPreparationLoader({ loadModule: () => { loads += 1; return gate.promise; } });
  assert.equal(loads, 0);
  const first = load();
  assert.equal(load(), first);
  await Promise.resolve();
  assert.equal(loads, 1);
  gate.resolve(module);
  assert.equal(await first, module);
  assert.equal(await load(), module);
  assert.equal(loads, 1);
});

test('failed or invalid preparation modules require reload without retrying imports', async () => {
  for (const result of [() => { throw new Error('network'); }, () => ({})]) {
    let loads = 0;
    const load = createProfilePhotoPreparationLoader({ loadModule: () => { loads += 1; return result(); } });
    const first = load();
    await assert.rejects(first, { message: PHOTO_PREPARATION_RELOAD_MESSAGE });
    assert.equal(load(), first);
    await assert.rejects(load(), { message: PHOTO_PREPARATION_RELOAD_MESSAGE });
    assert.equal(loads, 1);
  }
});

test('a stalled import releases the UI with reload guidance and late arrival cannot recover it', async () => {
  const gate = deferred();
  let expire;
  const cleared = [];
  const load = createProfilePhotoPreparationLoader({
    loadModule: () => gate.promise,
    setTimer: (callback, delay) => { assert.equal(delay, 30000); expire = callback; return 123; },
    clearTimer: (timer) => cleared.push(timer),
  });
  const first = load();
  expire();
  await assert.rejects(first, { message: PHOTO_PREPARATION_RELOAD_MESSAGE });
  gate.resolve({ prepareProfilePhoto: () => {} });
  await new Promise(setImmediate);
  assert.deepEqual(cleared, [123]);
  assert.equal(load(), first);
  await assert.rejects(load(), { message: PHOTO_PREPARATION_RELOAD_MESSAGE });
});

test('only the deferred preparation module contains browser image processing', () => {
  const shared = readFileSync(new URL('./profile-photo.mjs', import.meta.url), 'utf8');
  const profile = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');
  const loader = readFileSync(new URL('./profile-photo-preparation-loader.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(shared, /createImageBitmap|createObjectURL|createElement\('canvas'\)|drawImage|toBlob|convertToBlob|from '\.\/profile-photo-preparation/);
  assert.match(loader, /import\('\.\/profile-photo-preparation\.mjs'\)/);
  assert.doesNotMatch(profile, /from '\.\/profile-photo-preparation\.mjs'/);
  const handler = profile.slice(profile.indexOf("profilePhotoInput?.addEventListener('change'"), profile.indexOf("profileForm?.addEventListener('submit'"));
  assert.match(handler, /const preparationOwner = captureProfileOwner\(\)/);
  assert.match(handler, /const \{ prepareProfilePhoto \} = await loadProfilePhotoPreparation\(\);\s+if \(!isCurrentPreparation\(\)\) return;\s+const preparedPhoto = await prepareProfilePhoto\(file\);\s+if \(!isCurrentPreparation\(\)\) return;/);
  assert.match(handler, /catch \(error\) \{\s+if \(!isCurrentPreparation\(\)\) return;/);
  assert.match(profile, /function invalidateProfileOwner[^}]*photoPreparationSequence \+= 1;/);
});

for (const phase of ['import', 'prepare']) for (const fail of [false, true]) {
  test(`stale profile owner suppresses ${phase} ${fail ? 'failure' : 'success'} without touching the replacement account`, { timeout: 1000 }, async () => {
    const source = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf("profilePhotoInput?.addEventListener('change'"), source.indexOf("profileForm?.addEventListener('submit'"));
    const gate = deferred();
    const preparationStarted = deferred();
    const owner = { userId: 'owner-a', epoch: 1 };
    let currentOwner = owner;
    let change;
    let preparations = 0;
    const feedback = [];
    const busy = [];
    const file = { name: 'photo.jpg' };
    const module = { prepareProfilePhoto: () => {
      preparations += 1;
      preparationStarted.resolve();
      if (phase === 'prepare') return gate.promise;
      throw new Error('A stale import must not begin processing.');
    } };
    const scope = {
      profilePhotoInput: { files: [file], addEventListener: (_event, listener) => { change = listener; } },
      photoPreparationSequence: 0, selectedPhotoFile: null, selectedPreparedPhoto: null,
      revokeSelectedPreview: () => {}, renderPhotoSelection: () => {},
      captureProfileOwner: () => owner, isCurrentProfileOwner: (value) => value === currentOwner,
      setProfileFormBusy: (value) => busy.push(value), setProfileFeedback: (value) => feedback.push(value),
      loadProfilePhotoPreparation: () => phase === 'import' ? gate.promise : Promise.resolve(module),
      URL: { createObjectURL: () => { throw new Error('A stale result must not become a preview.'); } },
      renderAvatar: () => { throw new Error('A stale result must not render an avatar.'); },
    };
    runInNewContext(handler, scope);
    const pending = change();
    if (phase === 'prepare') await preparationStarted.promise;
    currentOwner = { userId: 'owner-b', epoch: 2 };
    if (fail) gate.reject(new Error('Delayed failure'));
    else gate.resolve(phase === 'import' ? module : { blob: {}, width: 256, height: 256 });
    await pending;
    assert.equal(preparations, phase === 'import' ? 0 : 1);
    assert.equal(feedback.length, 1, 'only the original Preparing message was emitted');
    assert.deepEqual(busy, [true], 'stale completion cannot re-enable replacement-account controls');
    assert.equal(scope.selectedPreparedPhoto, null);
  });
}
