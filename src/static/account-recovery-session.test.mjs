import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { revokeRecoverySessions } from './account-recovery-session.mjs';

describe('password-recovery session revocation', () => {
  test('confirms global revocation without a local fallback', async () => {
    const calls = [];
    const result = await revokeRecoverySessions({
      signOut: async (options) => {
        calls.push(options);
        return { error: null };
      },
    });

    assert.deepEqual(result, { scope: 'global' });
    assert.deepEqual(calls, [undefined]);
  });

  test('ends the local recovery session when global revocation fails', async () => {
    const globalError = new Error('network unavailable');
    const calls = [];
    const result = await revokeRecoverySessions({
      signOut: async (options) => {
        calls.push(options);
        return options ? { error: null } : { error: globalError };
      },
    });

    assert.equal(result.scope, 'local');
    assert.equal(result.globalError, globalError);
    assert.deepEqual(calls, [undefined, { scope: 'local' }]);
  });

  test('fails closed when neither sign-out attempt clears local auth', async () => {
    const globalError = new Error('global failed');
    const localError = new Error('local failed');

    await assert.rejects(
      revokeRecoverySessions({
        signOut: async (options) => ({ error: options ? localError : globalError }),
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match(error.message, /password was changed/i);
        assert.deepEqual(error.errors, [globalError, localError]);
        return true;
      },
    );
  });
});

