import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  grantCanaryQuery,
  grantPreflightQuery,
  grantVerificationQuery,
  manageProductionCanaryEntitlement,
  revokeCanaryQuery,
  revokeVerificationQuery,
  verifyGrantPreflightResponse,
  verifyGrantResponse,
  verifyRevokeResponse,
} from "./manage-production-canary-entitlement.mjs";
import { PRODUCTION_SUPABASE_PROJECT_REF } from "./production-auth-canary-policy.mjs";
import { reconciledHistoryVersions } from "./verify-production-migration-cutover-plan.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github/workflows/manage-production-canary-entitlement.yml",
);
const releaseSha = "a".repeat(40);
const accessToken = "test-management-token-never-print";
const writeUrl =
  `https://api.supabase.com/v1/projects/${PRODUCTION_SUPABASE_PROJECT_REF}/database/query`;
const readOnlyUrl = `${writeUrl}/read-only`;

const exactPreflight = Object.freeze({
  billing_customer_count: "0",
  legacy_purchases_table: null,
  matching_profile_count: "1",
  membership_count: "0",
  migration_history_matches: true,
  nonanonymous_user_count: "1",
  release_sha_is_canonical: true,
  subscription_count: "0",
});

const exactGrant = Object.freeze({
  active_membership_count: "1",
  billing_customer_count: "0",
  legacy_purchases_table: null,
  matching_canary_count: "1",
  matching_profile_count: "1",
  membership_count: "1",
  migration_history_matches: true,
  nonanonymous_user_count: "1",
  production_canary_count: "1",
  subscription_count: "0",
});

const exactRevoke = Object.freeze({
  active_production_canary_count: "0",
  matching_revoked_count: "1",
  production_canary_count: "1",
});

function response({
  body,
  jsonValue,
  redirected = false,
  status = 201,
} = {}) {
  return {
    body,
    redirected,
    status,
    json: async () => jsonValue,
  };
}

function options(overrides = {}) {
  return {
    accessToken,
    authVerifier: async () => true,
    environment: {},
    operation: "grant",
    projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
    releaseSha,
    signalFactory: () => undefined,
    ...overrides,
  };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("Expected rejection.");
}

test("grant preflight accepts only the exact migration-13, account, and empty-data boundary", () => {
  assert.equal(verifyGrantPreflightResponse([exactPreflight]), true);
  for (const changed of [
    { migration_history_matches: false },
    { release_sha_is_canonical: false },
    { nonanonymous_user_count: "2" },
    { matching_profile_count: "0" },
    { membership_count: "1" },
    { billing_customer_count: "1" },
    { subscription_count: "1" },
    { legacy_purchases_table: "public.purchases" },
  ]) {
    assert.throws(
      () => verifyGrantPreflightResponse([{ ...exactPreflight, ...changed }]),
      /release SHA|migration-13|exactly one non-anonymous|zero existing|globally empty|removed public\.purchases/u,
    );
  }
});

test("grant and revoke verification require exact aggregate shapes", () => {
  assert.equal(verifyGrantResponse([exactGrant]), true);
  assert.equal(verifyRevokeResponse([exactRevoke]), true);

  for (const invalid of [
    [],
    [exactGrant, exactGrant],
    [{ ...exactGrant, unexpected: "field" }],
    [{ ...exactGrant, matching_canary_count: "0" }],
  ]) {
    assert.throws(
      () => verifyGrantResponse(invalid),
      /exactly one aggregate row|unexpected aggregate shape|exact bounded grant/u,
    );
  }
  for (const invalid of [
    [],
    [{ ...exactRevoke, unexpected: "field" }],
    [{ ...exactRevoke, active_production_canary_count: "1" }],
    [{ ...exactRevoke, matching_revoked_count: "0" }],
  ]) {
    assert.throws(
      () => verifyRevokeResponse(invalid),
      /exactly one aggregate row|unexpected aggregate shape|revoked audit row/u,
    );
  }
});

test("grant auto-selects one profiled user and generates the grant UUID only inside SQL", () => {
  assert.match(grantCanaryQuery, /nonanonymous_user_count <> 1 or matching_profile_count <> 1/u);
  assert.match(grantCanaryQuery, /inner join public\.profiles profile on profile\.user_id = candidate\.id/u);
  assert.match(grantCanaryQuery, /pg_catalog\.gen_random_uuid\(\)::text/u);
  assert.match(grantCanaryQuery, /grant_start \+ interval '2 hours'/u);
  assert.match(grantCanaryQuery, /pg_catalog\.jsonb_build_object\('release_sha', target_release\)/u);
  assert.match(grantCanaryQuery, /zero existing membership entitlements/u);
  assert.match(grantCanaryQuery, /lock table supabase_migrations\.schema_migrations in share mode/u);
  assert.match(grantCanaryQuery, /do \$production_canary\$/u);
  assert.doesNotMatch(grantCanaryQuery, /\bbegin;|\bcommit;/iu);
  assert.doesNotMatch(grantCanaryQuery, /delete\s+from public\.entitlements/iu);
  assert.doesNotMatch(grantCanaryQuery, /canary_user_id|canary_grant_id|\\set/iu);
  assert.doesNotMatch(grantCanaryQuery, /\$[1-9]/u);
  for (const version of reconciledHistoryVersions) {
    assert.match(grantCanaryQuery, new RegExp(version, "u"));
    assert.match(grantPreflightQuery, new RegExp(version, "u"));
  }
});

test("revoke binds the sole active row to source, UUID format, and exact release while preserving it", () => {
  assert.match(revokeCanaryQuery, /matching_active_count <> 1 or total_active_canary_count <> 1/u);
  assert.match(revokeCanaryQuery, /source_type = 'production_canary'/u);
  assert.match(revokeCanaryQuery, /source_id ~\*/u);
  assert.match(revokeCanaryQuery, /metadata ->> 'release_sha' = target_release/u);
  assert.match(revokeCanaryQuery, /status = 'revoked'/u);
  assert.doesNotMatch(revokeCanaryQuery, /delete\s+from/iu);
  assert.doesNotMatch(revokeCanaryQuery, /canary_user_id|canary_grant_id|user_id\s*=/iu);
  assert.match(revokeVerificationQuery, /matching_revoked_count/u);
  assert.match(revokeVerificationQuery, /active_production_canary_count/u);
});

test("grant verifies closed Auth, preflights read-only, writes once, then verifies read-only", async () => {
  const calls = [];
  const authCalls = [];
  let writeBodyCancelled = false;
  const queue = [
    response({ jsonValue: [exactPreflight] }),
    response({ body: { cancel: async () => { writeBodyCancelled = true; } } }),
    response({ jsonValue: [exactGrant] }),
  ];
  const result = await manageProductionCanaryEntitlement(options({
    authVerifier: async (value) => {
      authCalls.push(value);
      return true;
    },
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return queue.shift();
    },
  }));

  assert.deepEqual(result, { operation: "grant", verified: true });
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].accessToken, accessToken);
  assert.equal(authCalls[0].projectRef, PRODUCTION_SUPABASE_PROJECT_REF);
  assert.deepEqual(calls.map(({ url }) => url), [readOnlyUrl, writeUrl, readOnlyUrl]);
  assert.equal(writeBodyCancelled, true);
  assert.deepEqual(
    calls.map(({ request }) => JSON.parse(request.body)),
    [
      { query: grantPreflightQuery, parameters: [releaseSha] },
      {
        query: grantCanaryQuery.replace(
          "__PRODUCTION_CANARY_RELEASE_SHA__",
          releaseSha,
        ),
        parameters: [],
      },
      { query: grantVerificationQuery, parameters: [releaseSha] },
    ],
  );
  for (const { request } of calls) {
    assert.deepEqual(request.headers, {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    });
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
  }
});

test("a failed grant preflight never reaches the write endpoint", async () => {
  const calls = [];
  await assert.rejects(
    manageProductionCanaryEntitlement(options({
      fetchImpl: async (url) => {
        calls.push(url);
        return response({
          jsonValue: [{ ...exactPreflight, membership_count: "1" }],
        });
      },
    })),
    /zero existing membership entitlements/u,
  );
  assert.deepEqual(calls, [readOnlyUrl]);
});

test("revoke writes and verifies without needing Auth configuration or identifiers", async () => {
  const calls = [];
  let authCalled = false;
  const queue = [response(), response({ jsonValue: [exactRevoke] })];
  assert.deepEqual(
    await manageProductionCanaryEntitlement(options({
      operation: "revoke",
      authVerifier: async () => {
        authCalled = true;
      },
      fetchImpl: async (url, request) => {
        calls.push({ url, request });
        return queue.shift();
      },
    })),
    { operation: "revoke", verified: true },
  );
  assert.equal(authCalled, false);
  assert.deepEqual(calls.map(({ url }) => url), [writeUrl, readOnlyUrl]);
  assert.deepEqual(JSON.parse(calls[0].request.body), {
    query: revokeCanaryQuery.replace(
      "__PRODUCTION_CANARY_RELEASE_SHA__",
      releaseSha,
    ),
    parameters: [],
  });
  assert.deepEqual(JSON.parse(calls[1].request.body), {
    query: revokeVerificationQuery,
    parameters: [releaseSha],
  });
});

test("invalid operation, project, SHA, token, or Node environment fails before requests", async () => {
  const invalidOptions = [
    { operation: "replace" },
    { projectRef: "abcdefghijklmnopqrst" },
    { releaseSha: "main" },
    { releaseSha: "A".repeat(40) },
    { accessToken: " token" },
    { accessToken: "token\n" },
    { environment: { NODE_DEBUG: "http" } },
    { environment: { NODE_OPTIONS: "--require=/tmp/untrusted.cjs" } },
    { environment: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
    { environment: { NODE_USE_ENV_PROXY: "1" } },
  ];
  for (const changed of invalidOptions) {
    let called = false;
    await assert.rejects(
      manageProductionCanaryEntitlement(options({
        ...changed,
        fetchImpl: async () => {
          called = true;
          return response();
        },
      })),
      /operation|project|GITHUB_SHA|ACCESS_TOKEN|must be unset/u,
    );
    assert.equal(called, false);
  }
});

test("network, status, redirect, and parse failures never disclose tokens or bodies", async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`network included ${accessToken}`); },
    async () => response({ status: 403 }),
    async () => response({ redirected: true }),
    async () => response({ jsonValue: undefined }),
  ]) {
    const error = await captureRejection(
      manageProductionCanaryEntitlement(options({ fetchImpl })),
    );
    assert.doesNotMatch(error.message, new RegExp(accessToken, "u"));
    assert.doesNotMatch(error.message, /network included/u);
  }

  let errorBodyRead = false;
  const error = await captureRejection(
    manageProductionCanaryEntitlement(options({
      fetchImpl: async () => ({
        status: 500,
        redirected: false,
        json: async () => {
          errorBodyRead = true;
          return { secret: accessToken };
        },
      }),
    })),
  );
  assert.match(error.message, /HTTP 500/u);
  assert.equal(errorBodyRead, false);
  assert.doesNotMatch(error.message, new RegExp(accessToken, "u"));
});

test("workflow is manual, main-only, canonical-repository, production protected, and identifier-free", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(source, /^\s+(?:push|pull_request|schedule):/mu);
  assert.match(source, /GITHUB_EVENT_NAME.*workflow_dispatch/u);
  assert.match(source, /GITHUB_REPOSITORY.*tjames222\/77-dominion-challenge/u);
  assert.match(source, /GITHUB_REF.*refs\/heads\/main/u);
  assert.match(source, /GITHUB_SHA.*\^\[0-9a-f\]\{40\}\$/u);
  assert.match(source, /confirm_production_change/u);
  assert.match(source, /PRODUCTION_CANARY_OPERATION/u);
  assert.match(source, /group: production-release/u);
  assert.match(source, /^\s{4}environment: production$/mu);
  assert.match(source, /SUPABASE_ACCESS_TOKEN: \$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/u);
  assert.match(source, /SUPABASE_PROJECT_REF: \$\{\{ vars\.SUPABASE_PROJECT_REF \}\}/u);
  assert.match(source, /persist-credentials: false/u);
  assert.match(source, /node scripts\/manage-production-canary-entitlement\.mjs/u);
  const launcher = source.split("/usr/bin/env -i ")[1];
  assert.ok(launcher, "the privileged helper must start with an empty environment");
  assert.deepEqual(
    [...launcher.matchAll(/^\s+([A-Z_]+)=/gmu)].map((match) => match[1]),
    [
      "GITHUB_SHA", "HOME", "LANG", "PATH", "PRODUCTION_CANARY_OPERATION",
      "SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF", "TMPDIR",
    ],
  );
  assert.doesNotMatch(source, /canary_user_id|canary_grant_id|user_uuid|grant_uuid/iu);
  assert.doesNotMatch(source, /supabase\s+(?:db|link)|psql|\\set|database-url/iu);
});
