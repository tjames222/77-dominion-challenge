import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const actor = 'preview_owner';
const instanceId = '00000000-0000-4000-8000-000000000001';
function fixture() {
  let initialized = false;
  let currentActor = actor;
  let currentInstance = instanceId;
  const calls = [];
  const context = {
    URL, Date,
    getLocalOrSessionUser: async () => ({ authenticated: true, userId: currentActor }),
    isLocalDemoMode: () => true,
    withPreviewAggregate: async (owner, operation) => {
      calls.push(owner);
      if (owner !== currentActor) throw new Error('The signed-in account changed. Try again.');
      initialized = true;
      return operation();
    },
    mockSharePresentation: kind => {
      assert.equal(initialized, true, 'share-first must initialize under the actor lock');
      return { schemaVersion: 3, kind, payload: { schemaVersion: 3, kind } };
    },
    readMockChallengeActivation: () => ({ currentInstance: { id: currentInstance } }),
    randomId: () => 'preview_snapshot',
    window: { location: { href: 'https://preview.example/dashboard.html' } },
  };
  const source = api.slice(api.indexOf('function verifiedShareContext'), api.indexOf('export async function createSharingRewardIntent'))
    .replace(/^export /gm, '');
  runInNewContext(`${source}\nglobalThis.preview = previewShareSnapshot; globalThis.create = createShareSnapshot;`, context);
  return { ...context, calls, actor(value) { currentActor = value; }, instance(value) { currentInstance = value; } };
}

test('a share-first preview and creation initialize the same actor-scoped aggregate', async () => {
  const f = fixture();
  const preview = await f.preview('progress', { expectedUserId: actor });
  assert.equal(preview.context.instanceId, instanceId);
  const result = await f.create('progress', { expectedUserId: actor, expectedInstanceId: instanceId });
  assert.equal(result.context.actorId, actor);
  assert.equal(result.context.instanceId, instanceId);
  assert.equal(result.preview, true);
  assert.deepEqual(f.calls, [actor, actor]);
});

test('preview links reject account switches and replaced runs before returning a link', async () => {
  const f = fixture();
  await f.preview('progress', { expectedUserId: actor });
  f.instance('00000000-0000-4000-8000-000000000002');
  await assert.rejects(f.create('progress', { expectedUserId: actor, expectedInstanceId: instanceId }), /challenge changed/);
  f.actor('other_owner');
  await assert.rejects(f.create('progress', { expectedUserId: actor, expectedInstanceId: instanceId }), /account changed/);
  await assert.rejects(f.preview('progress', { expectedUserId: actor }), /account changed/);
});

test('non-progress previews never include a private run identifier', async () => {
  const f = fixture();
  const preview = await f.preview('general', { expectedUserId: actor });
  assert.equal(preview.context.instanceId, null);
  const result = await f.create('general', { expectedUserId: actor });
  assert.equal(result.context.instanceId, null);
});
