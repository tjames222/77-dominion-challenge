import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLOSED_AUTH_CONFIG_PATCH,
  configureProductionAuthCanary,
  PRODUCTION_SUPABASE_PROJECT_REF,
  productionAuthCanaryErrors,
  verifyProductionAuthCanary,
} from "./production-auth-canary-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const policyWorkflow = path.join(
  repositoryRoot,
  ".github/workflows/configure-production-auth-canary.yml",
);
const accessToken = "test-management-token";
const authConfigUrl =
  `https://api.supabase.com/v1/projects/${PRODUCTION_SUPABASE_PROJECT_REF}/config/auth`;

function exactResponse({
  status = 200,
  redirected = false,
  json = async () => ({
    disable_signup: true,
    external_anonymous_users_enabled: false,
  }),
} = {}) {
  return { status, redirected, json };
}

function options(overrides = {}) {
  return {
    accessToken,
    projectRef: PRODUCTION_SUPABASE_PROJECT_REF,
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
  assert.fail("Expected the promise to reject.");
}

test("the closed policy requires exact booleans", () => {
  assert.deepEqual(productionAuthCanaryErrors(null), [
    "Supabase returned an invalid Auth configuration response",
  ]);
  assert.deepEqual(productionAuthCanaryErrors([]), [
    "Supabase returned an invalid Auth configuration response",
  ]);
  assert.deepEqual(productionAuthCanaryErrors({}), [
    "Supabase Auth disable_signup must be true",
    "Supabase Auth external_anonymous_users_enabled must be false",
  ]);
  assert.deepEqual(
    productionAuthCanaryErrors({
      disable_signup: 1,
      external_anonymous_users_enabled: 0,
    }),
    [
      "Supabase Auth disable_signup must be true",
      "Supabase Auth external_anonymous_users_enabled must be false",
    ],
  );
  assert.deepEqual(
    productionAuthCanaryErrors({
      disable_signup: true,
      external_anonymous_users_enabled: false,
      unrelated: "ignored",
    }),
    [],
  );
});

test("configuration PATCHes only the fixed fields and then GET-verifies", async () => {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    return exactResponse();
  };

  assert.equal(
    await configureProductionAuthCanary(options({ fetchImpl })),
    true,
  );
  assert.equal(calls.length, 2);

  const [patchCall, getCall] = calls;
  assert.equal(patchCall.url, authConfigUrl);
  assert.deepEqual(patchCall.request, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify(CLOSED_AUTH_CONFIG_PATCH),
  });
  assert.deepEqual(JSON.parse(patchCall.request.body), {
    disable_signup: true,
    external_anonymous_users_enabled: false,
  });

  assert.equal(getCall.url, authConfigUrl);
  assert.deepEqual(getCall.request, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
    redirect: "error",
  });
});

test("configuration is pinned to the reviewed production project", async () => {
  let fetchCalled = false;
  await assert.rejects(
    configureProductionAuthCanary(
      options({
        projectRef: "abcdefghijklmnopqrst",
        fetchImpl: async () => {
          fetchCalled = true;
          return exactResponse();
        },
      }),
    ),
    /must be the reviewed production project/u,
  );
  assert.equal(fetchCalled, false);
});

test("invalid tokens and runtimes fail before a request", async () => {
  for (const invalidToken of [undefined, "", " token", "token\n"]) {
    await assert.rejects(
      verifyProductionAuthCanary(
        options({ accessToken: invalidToken, fetchImpl: async () => exactResponse() }),
      ),
      /SUPABASE_ACCESS_TOKEN/u,
    );
  }

  await assert.rejects(
    verifyProductionAuthCanary(options({ fetchImpl: null })),
    /Fetch-compatible runtime/u,
  );
  await assert.rejects(
    verifyProductionAuthCanary(
      options({ fetchImpl: async () => exactResponse(), signalFactory: null }),
    ),
    /signal factory/u,
  );
});

test("PATCH failures do not read a response body or continue to GET", async () => {
  let jsonRead = false;
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return exactResponse({
      status: 403,
      json: async () => {
        jsonRead = true;
        throw new Error("sensitive response body");
      },
    });
  };

  await assert.rejects(
    configureProductionAuthCanary(options({ fetchImpl })),
    /update failed \(HTTP 403\)/u,
  );
  assert.equal(requestCount, 1);
  assert.equal(jsonRead, false);
});

test("GET failures do not read a response body", async () => {
  let jsonRead = false;
  const fetchImpl = async () =>
    exactResponse({
      status: 429,
      json: async () => {
        jsonRead = true;
        throw new Error("sensitive response body");
      },
    });

  await assert.rejects(
    verifyProductionAuthCanary(options({ fetchImpl })),
    /verification failed \(HTTP 429\)/u,
  );
  assert.equal(jsonRead, false);
});

test("redirects and undocumented success statuses fail closed", async () => {
  await assert.rejects(
    verifyProductionAuthCanary(
      options({ fetchImpl: async () => exactResponse({ redirected: true }) }),
    ),
    /verification failed \(HTTP 200\)/u,
  );
  await assert.rejects(
    verifyProductionAuthCanary(
      options({ fetchImpl: async () => exactResponse({ status: 204 }) }),
    ),
    /verification failed \(HTTP 204\)/u,
  );
  await assert.rejects(
    verifyProductionAuthCanary(
      options({ fetchImpl: async () => exactResponse({ status: 302 }) }),
    ),
    /verification failed \(HTTP 302\)/u,
  );
});

test("network and parse errors never echo a token or response details", async () => {
  const networkError = await captureRejection(
    verifyProductionAuthCanary(
      options({
        fetchImpl: async () => {
          throw new Error(`upstream included ${accessToken}`);
        },
      }),
    ),
  );
  assert.doesNotMatch(networkError.message, new RegExp(accessToken, "u"));
  assert.doesNotMatch(networkError.message, /upstream included/u);

  const parseError = await captureRejection(
    verifyProductionAuthCanary(
      options({
        fetchImpl: async () =>
          exactResponse({
            json: async () => {
              throw new Error(`body included ${accessToken}`);
            },
          }),
      }),
    ),
  );
  assert.equal(
    parseError.message,
    "Supabase returned an invalid Auth configuration response.",
  );
});

test("an open policy fails without printing unrelated response fields", async () => {
  const error = await captureRejection(
    verifyProductionAuthCanary(
      options({
        fetchImpl: async () =>
          exactResponse({
            json: async () => ({
              disable_signup: false,
              external_anonymous_users_enabled: true,
              smtp_pass: "must-never-appear",
            }),
          }),
      }),
    ),
  );
  assert.match(error.message, /Production canary is not closed/u);
  assert.doesNotMatch(error.message, /must-never-appear/u);
});

test("the workflow is manual, main-only, and production-environment protected", async () => {
  const source = await readFile(policyWorkflow, "utf8");

  assert.match(source, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(source, /^\s+(?:push|pull_request|schedule):/mu);
  assert.match(source, /GITHUB_REF.*refs\/heads\/main/u);
  assert.match(source, /CONFIRM_CLOSED_CANARY/u);
  assert.match(source, /^\s{4}environment: production$/mu);
  assert.match(
    source,
    /SUPABASE_ACCESS_TOKEN: \$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/u,
  );
  assert.match(
    source,
    /SUPABASE_PROJECT_REF: \$\{\{ vars\.SUPABASE_PROJECT_REF \}\}/u,
  );
  assert.match(
    source,
    /node scripts\/configure-production-auth-canary\.mjs/u,
  );
});
