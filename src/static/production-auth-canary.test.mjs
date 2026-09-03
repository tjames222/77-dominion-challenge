import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  productionAuthCanaryErrors,
  verifyProductionAuthCanary,
} from '../../scripts/verify-production-auth-canary.mjs';
import {
  PRODUCTION_RECOVERY_REDIRECT_URL,
  PRODUCTION_SITE_URL,
  PRODUCTION_SUPABASE_PROJECT_REF,
} from '../../scripts/production-auth-canary-policy.mjs';

describe('production Supabase Auth canary gate', () => {
  test('requires public signup paths to be closed at the exact production URLs', () => {
    assert.deepEqual(productionAuthCanaryErrors({
      disable_signup: true,
      external_anonymous_users_enabled: false,
      site_url: PRODUCTION_SITE_URL,
      uri_allow_list: PRODUCTION_RECOVERY_REDIRECT_URL,
    }), []);
    assert.deepEqual(productionAuthCanaryErrors({
      disable_signup: false,
      external_anonymous_users_enabled: true,
      site_url: 'https://wrong.example',
      uri_allow_list: 'https://wrong.example/reset-password.html',
    }), [
      'Supabase Auth disable_signup must be true',
      'Supabase Auth external_anonymous_users_enabled must be false',
      'Supabase Auth site_url must be the reviewed production origin',
      'Supabase Auth uri_allow_list must contain only the reviewed recovery redirect',
    ]);
    assert.deepEqual(productionAuthCanaryErrors({}), [
      'Supabase Auth disable_signup must be true',
      'Supabase Auth external_anonymous_users_enabled must be false',
      'Supabase Auth site_url must be the reviewed production origin',
      'Supabase Auth uri_allow_list must contain only the reviewed recovery redirect',
    ]);
  });

  test('uses the official read-only Management API endpoint without a request body', async () => {
    const calls = [];
    const verified = await verifyProductionAuthCanary({
      accessToken: 'test-management-token',
      projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
      fetchImpl: async (...args) => {
        calls.push(args);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            disable_signup: true,
            external_anonymous_users_enabled: false,
            site_url: PRODUCTION_SITE_URL,
            uri_allow_list: PRODUCTION_RECOVERY_REDIRECT_URL,
          }),
        };
      },
    });

    assert.equal(verified, true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0][0],
      `https://api.supabase.com/v1/projects/${PRODUCTION_SUPABASE_PROJECT_REF}/config/auth`,
    );
    const { signal, ...requestOptions } = calls[0][1];
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(requestOptions, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer test-management-token',
      },
      cache: 'no-store',
      redirect: 'error',
    });
    assert.equal('body' in calls[0][1], false);
  });

  test('never includes the Auth response payload in a failure', async () => {
    const responseMarker = 'DO_NOT_LOG_AUTH_CONFIG_RESPONSE';
    let rejectedBodyReads = 0;
    await assert.rejects(
      verifyProductionAuthCanary({
        accessToken: 'test-management-token',
        projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            disable_signup: false,
            external_anonymous_users_enabled: true,
            responseMarker,
          }),
        }),
      }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(responseMarker));
        assert.match(error.message, /Production canary is not closed/);
        return true;
      },
    );

    await assert.rejects(
      verifyProductionAuthCanary({
        accessToken: 'test-management-token',
        projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
        fetchImpl: async () => ({
          ok: false,
          status: 403,
          json: async () => {
            rejectedBodyReads += 1;
            return { responseMarker };
          },
        }),
      }),
      (error) => {
        assert.equal(error.message, 'Supabase Auth configuration verification failed (HTTP 403).');
        assert.doesNotMatch(error.message, new RegExp(responseMarker));
        return true;
      },
    );
    assert.equal(rejectedBodyReads, 0);
  });

  test('fails closed for missing credentials, network errors, and invalid JSON', async () => {
    await assert.rejects(
      verifyProductionAuthCanary({ accessToken: '', projectRef: PRODUCTION_SUPABASE_PROJECT_REF }),
      /SUPABASE_ACCESS_TOKEN must be a non-empty token/,
    );
    await assert.rejects(
      verifyProductionAuthCanary({ accessToken: 'token', projectRef: '' }),
      /SUPABASE_PROJECT_REF must be the reviewed production project/,
    );
    await assert.rejects(
      verifyProductionAuthCanary({
        accessToken: 'token',
        projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
        fetchImpl: async () => { throw new Error('response payload'); },
      }),
      /Supabase Auth configuration verification request failed\./,
    );
    await assert.rejects(
      verifyProductionAuthCanary({
        accessToken: 'token',
        projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => { throw new Error('response payload'); },
        }),
      }),
      /Supabase returned an invalid Auth configuration response\./,
    );
  });
});
