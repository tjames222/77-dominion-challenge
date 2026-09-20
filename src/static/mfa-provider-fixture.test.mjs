import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAdminContext } from './admin-read-client.mjs';
import { installMfaSupabaseStub } from '../../tests/e2e/support/mfa-supabase-auth-stub.mjs';

test('MFA browser provider supplies the real non-admin readiness contract for shared navigation', async () => {
  let handler;
  await installMfaSupabaseStub({ route: async (_pattern, callback) => { handler = callback; } }, { enrolled: false });
  let response;
  await handler({
    request: () => ({
      url: () => 'http://127.0.0.1/__mfa_fixture__/rest/v1/rpc/get_site_admin_context',
      headers: () => ({}), method: () => 'POST', postData: () => null,
    }),
    fulfill: async value => { response = value; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(normalizeAdminContext(JSON.parse(response.body), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), {
    schemaVersion: 1, actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'member',
    adminReady: false, reason: null, permissions: [],
  });
});
