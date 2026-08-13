import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const api = read('./api.js');
const recovery = read('./password-recovery.js');
const profile = read('../../profile.html');
const profileJs = read('./profile.js');
const login = read('../../login.html');
const register = read('../../register.html');
const billing = read('../../billing.html');
const membership = read('../../membership.html');
const menu = read('./menu.js');
const migration = read('../../supabase/migrations/20260813163428_add_account_lifecycle_requests.sql');

describe('FOU-761 account recovery and lifecycle UI', () => {
  test('publishes fixed password recovery routes and a discoverable login path', () => {
    assert.equal(PRODUCTION_ENTRYPOINTS.forgotPassword, 'forgot-password.html');
    assert.equal(PRODUCTION_ENTRYPOINTS.resetPassword, 'reset-password.html');
    assert.match(login, /href="\.\/forgot-password\.html"/);
    assert.match(read('../../forgot-password.html'), /id="passwordRecoveryRequestForm"/);
    assert.match(read('../../reset-password.html'), /id="passwordResetForm"[\s\S]*?autocomplete="new-password"/);
    assert.match(api, /resetPasswordForEmail\(normalizedEmail, \{ redirectTo \}\)/);
    assert.match(api, /updateUser\(\{ password: value \}\)/);
    assert.match(api, /default sign-out scope is global[\s\S]*?auth\.signOut\(\)/);
    assert.match(recovery, /window\.history\.replaceState/);
    assert.match(recovery, /If an account uses that email/);
  });

  test('exposes tracked export and deletion requests from Profile', () => {
    for (const id of [
      'account-data',
      'requestDataExportButton',
      'requestAccountDeletionButton',
      'dataExportRequestStatus',
      'accountDeletionRequestStatus',
      'accountRequestFeedback',
    ]) assert.match(profile, new RegExp(`id="${id}"`));
    assert.match(profileJs, /getAccountLifecycleRequests/);
    assert.match(profileJs, /createAccountLifecycleRequest/);
    assert.match(profileJs, /window\.confirm\([\s\S]*?permanent account deletion/i);
    assert.match(api, /\.from\('account_lifecycle_requests'\)/);
    assert.match(api, /isActiveAccountRequestConflict/);
  });

  test('keeps member writes owner-only, outcome-free, and replay-safe in SQL', () => {
    assert.match(migration, /enable row level security/);
    assert.match(migration, /force row level security/);
    assert.match(migration, /using \(\(select auth\.uid\(\)\) = user_id\)/);
    assert.match(migration, /grant insert \(user_id, request_type\)/);
    assert.doesNotMatch(migration, /grant (?:update|delete).*authenticated/i);
    assert.match(migration, /create unique index account_lifecycle_requests_one_active_kind_idx/);
    assert.match(migration, /where user_id is not null and status in \('requested', 'in_progress'\)/);
  });

  test('links stable policy and support pages at the required decisions', () => {
    for (const [key, page] of [
      ['privacy', 'privacy.html'],
      ['terms', 'terms.html'],
      ['cancellationRefunds', 'cancellation-refunds.html'],
      ['support', 'support.html'],
    ]) {
      assert.equal(PRODUCTION_ENTRYPOINTS[key], page);
      const source = read(`../../${page}`);
      assert.match(source, /FOU-761 release gate/);
      assert.match(source, /src="\.\/src\/static\/legal\.js"/);
    }
    assert.match(register, /terms\.html[\s\S]*privacy\.html/i);
    assert.match(billing, /cancellation-refunds\.html[\s\S]*terms\.html[\s\S]*support\.html/);
    assert.match(membership, /terms\.html[\s\S]*privacy\.html[\s\S]*cancellation-refunds\.html/);
    assert.match(menu, /global-menu-policy-links[\s\S]*privacy\.html[\s\S]*terms\.html[\s\S]*support\.html/);
  });
});
