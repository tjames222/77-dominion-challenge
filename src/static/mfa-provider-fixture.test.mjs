import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAdminContext } from './admin-read-client.mjs';
import { installMfaSupabaseStub } from '../../tests/e2e/support/mfa-supabase-auth-stub.mjs';

test('MFA browser provider supplies the real non-admin readiness contract for shared navigation', async () => {
  let handler;
  await installMfaSupabaseStub({ route: async (_pattern, callback) => { handler = callback; } }, { enrolled: false });
  const request = async (path, token = '', body = {}) => {
    let response;
    await handler({
      request: () => ({
        url: () => `http://127.0.0.1/__mfa_fixture__${path}`,
        headers: () => token ? { authorization: `Bearer ${token}` } : {},
        method: () => 'POST', postData: () => JSON.stringify(body), postDataJSON: () => body,
      }),
      fulfill: async value => { response = value; },
    });
    return response;
  };
  const contextPath = '/rest/v1/rpc/get_site_admin_context';
  const args = { target_expected_actor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  assert.equal((await request(contextPath, '', args)).status, 401);
  const session = JSON.parse((await request('/auth/v1/token')).body);
  assert.equal((await request(contextPath, session.access_token, { target_expected_actor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).status, 401);
  const response = await request(contextPath, session.access_token, args);
  assert.equal(response.status, 200);
  assert.deepEqual(normalizeAdminContext(JSON.parse(response.body), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), {
    schemaVersion: 1, actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'member',
    adminReady: false, reason: null, permissions: [],
  });
});
