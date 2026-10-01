import assert from 'node:assert/strict';
import test from 'node:test';
import { installDailyBootstrapStub } from '../../tests/e2e/support/daily-bootstrap-supabase-stub.mjs';

async function fixtureHarness() {
  let handler;
  const fixture = await installDailyBootstrapStub({
    async addInitScript() {},
    async route(pattern, callback) {
      assert.equal(pattern, '**/__daily_fixture__/**');
      handler = callback;
    },
  });
  const request = (path) => {
    const response = { value: undefined };
    const done = handler({
      request: () => ({
        url: () => `http://127.0.0.1:4438/__daily_fixture__${path}`,
        method: () => path.includes('/rpc/') ? 'POST' : 'GET',
        postData: () => null,
        headers: () => ({}),
      }),
      fulfill: (value) => { response.value = value; },
    });
    return { response, done };
  };
  return { fixture, request };
}

test('Daily bootstrap fixture leaves Auth unheld until an armed successful bootstrap', async () => {
  const { fixture, request } = await fixtureHarness();
  const initial = request('/auth/v1/user');
  await initial.done;
  assert.equal(initial.response.value.status, 200);
  const release = fixture.holdPostBootstrapUser();
  try {
    const beforeBootstrap = request('/auth/v1/user');
    await beforeBootstrap.done;
    assert.equal(beforeBootstrap.response.value.status, 200);
    fixture.failNext();
    const failedBootstrap = request('/rest/v1/rpc/get_daily_action_bootstrap_v2');
    await failedBootstrap.done;
    assert.equal(failedBootstrap.response.value.status, 503);
    const afterFailure = request('/auth/v1/user');
    await afterFailure.done;
    assert.equal(afterFailure.response.value.status, 200);
    assert.equal(fixture.heldUserRequests(), 0);
  } finally { release(); }
});

test('Daily bootstrap fixture holds every concurrent post-bootstrap user check until release', async () => {
  const { fixture, request } = await fixtureHarness();
  const release = fixture.holdPostBootstrapUser();
  const held = [];
  try {
    await request('/rest/v1/rpc/get_daily_action_bootstrap_v2').done;
    // Simulate a shell verification arriving ahead of the focused read, then
    // another concurrent caller. None may consume a one-request-only hold.
    held.push(request('/auth/v1/user'), request('/auth/v1/user'));
    await Promise.resolve();
    held.push(request('/auth/v1/user'));
    assert.equal(fixture.heldUserRequests(), 3);
    assert(held.every(({ response }) => response.value === undefined));
    const unrelated = request('/rest/v1/rpc/get_challenge_activation_v2');
    await unrelated.done;
    assert.equal(unrelated.response.value.status, 200);
    assert(held.every(({ response }) => response.value === undefined));
  } finally { release(); }
  await Promise.all(held.map(({ done }) => done));
  assert(held.every(({ response }) => response.value.status === 200));
  release(); // The browser tests release both explicitly and in finally.
  const afterRelease = request('/auth/v1/user');
  await afterRelease.done;
  assert.equal(afterRelease.response.value.status, 200);
  assert.equal(fixture.heldUserRequests(), 3);
});
