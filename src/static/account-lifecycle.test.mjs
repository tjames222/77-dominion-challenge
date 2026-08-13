import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ACCOUNT_REQUEST_TYPES,
  accountRequestStatusLabel,
  assertAccountRequestType,
  isActiveAccountRequest,
  isActiveAccountRequestConflict,
  latestAccountRequestsByType,
  normalizeAccountLifecycleRequest,
} from './account-lifecycle.mjs';

describe('account lifecycle request state', () => {
  test('accepts only the two member-facing request kinds', () => {
    assert.equal(assertAccountRequestType(' DATA_EXPORT '), ACCOUNT_REQUEST_TYPES.DATA_EXPORT);
    assert.throws(() => assertAccountRequestType('admin_override'), /supported/);
  });

  test('normalizes database rows and rejects unknown states', () => {
    assert.deepEqual(normalizeAccountLifecycleRequest({
      id: 'request-1',
      user_id: 'user-1',
      request_type: 'account_deletion',
      status: 'requested',
      requested_at: '2026-08-13T12:00:00Z',
      updated_at: '2026-08-13T12:00:00Z',
      resolved_at: null,
      operator_note: null,
    }), {
      id: 'request-1',
      userId: 'user-1',
      requestType: 'account_deletion',
      status: 'requested',
      requestedAt: '2026-08-13T12:00:00Z',
      updatedAt: '2026-08-13T12:00:00Z',
      resolvedAt: null,
      operatorNote: '',
    });
    assert.equal(normalizeAccountLifecycleRequest({ request_type: 'data_export', status: 'unknown' }), null);
  });

  test('selects the newest status for each request kind', () => {
    const latest = latestAccountRequestsByType([
      { id: 'old', request_type: 'data_export', status: 'fulfilled', requested_at: '2026-08-01' },
      { id: 'new', request_type: 'data_export', status: 'requested', requested_at: '2026-08-13' },
      { id: 'delete', request_type: 'account_deletion', status: 'in_progress', requested_at: '2026-08-12' },
    ]);
    assert.equal(latest.get('data_export').id, 'new');
    assert.equal(latest.get('account_deletion').id, 'delete');
    assert.equal(isActiveAccountRequest(latest.get('data_export')), true);
    assert.equal(accountRequestStatusLabel('fulfilled'), 'Completed');
  });

  test('recognizes only the database uniqueness conflict as a safe replay', () => {
    assert.equal(isActiveAccountRequestConflict({ code: '23505' }), true);
    assert.equal(isActiveAccountRequestConflict({ code: '42501' }), false);
  });
});
