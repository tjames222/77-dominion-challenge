import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY,
  configureProductionProfilePhotoCleanupCron,
  EXTENSION_SETUP_QUERY,
  parseConfigurationResponse,
  parseExtensionSetupResponse,
  parseVerificationResponse,
  PROFILE_PHOTO_CLEANUP_CRON_COMMAND,
  VERIFY_PROFILE_PHOTO_CLEANUP_QUERY,
} from "./configure-production-profile-photo-cleanup-cron.mjs";
import { PRODUCTION_SUPABASE_PROJECT_REF } from "./production-auth-canary-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const accessToken = "test-management-access-token-never-log";
const projectRef = PRODUCTION_SUPABASE_PROJECT_REF;
const projectUrl = `https://${projectRef}.supabase.co`;
const workerSecret = "test-profile-worker-secret-never-log-1234567890";
const managementQueryUrl =
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

function exactVerification(overrides = {}) {
  return {
    pg_cron_schema_matches: true,
    pg_net_schema_matches: true,
    vault_schema_matches: true,
    project_url_secret_count: 1,
    project_url_secret_matches: true,
    worker_secret_count: 1,
    worker_secret_matches: true,
    job_count: 1,
    job_schedule_matches: true,
    job_command_matches: true,
    job_active: true,
    job_contains_no_embedded_url: true,
    job_contains_no_project_url: true,
    job_contains_no_worker_secret: true,
    ...overrides,
  };
}

function response(value, { status = 201, redirected = false, body } = {}) {
  return {
    status,
    redirected,
    body,
    json: async () => value,
  };
}

function options(overrides = {}) {
  return {
    accessToken,
    projectRef,
    projectUrl,
    workerSecret,
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

test("configures extensions, parameterized Vault values, one Cron job, and verifies exact state", async () => {
  const calls = [];
  const values = [
    [],
    [{ configured: true }],
    [exactVerification()],
  ];
  const fetchImplementation = async (url, request) => {
    calls.push({ url, request });
    return response(values[calls.length - 1]);
  };

  assert.equal(
    await configureProductionProfilePhotoCleanupCron(
      options({ fetchImplementation }),
    ),
    true,
  );
  assert.equal(calls.length, 3);

  for (const call of calls) {
    assert.equal(call.url, managementQueryUrl);
    assert.equal(call.request.method, "POST");
    assert.equal(call.request.redirect, "error");
    assert.equal(call.request.cache, "no-store");
    assert.deepEqual(call.request.headers, {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    });
  }

  assert.deepEqual(JSON.parse(calls[0].request.body), {
    query: EXTENSION_SETUP_QUERY,
    parameters: [],
    read_only: false,
  });
  assert.deepEqual(JSON.parse(calls[1].request.body), {
    query: CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY,
    parameters: [projectUrl, workerSecret],
    read_only: false,
  });
  assert.deepEqual(JSON.parse(calls[2].request.body), {
    query: VERIFY_PROFILE_PHOTO_CLEANUP_QUERY,
    parameters: [projectUrl, workerSecret],
    read_only: false,
  });
});

test("SQL uses supported extension schemas, a transaction lock, and only supported Cron APIs", () => {
  assert.match(
    EXTENSION_SETUP_QUERY,
    /create extension if not exists pg_cron with schema pg_catalog/u,
  );
  assert.match(
    EXTENSION_SETUP_QUERY,
    /create extension if not exists pg_net with schema extensions/u,
  );
  assert.match(EXTENSION_SETUP_QUERY, /pg_advisory_xact_lock/u);
  assert.match(EXTENSION_SETUP_QUERY, /set_config\('lock_timeout', '5s', true\)/u);
  assert.match(
    EXTENSION_SETUP_QUERY,
    /set_config\('statement_timeout', '30s', true\)/u,
  );

  assert.match(CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY, /pg_advisory_xact_lock/u);
  assert.match(CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY, /vault\.create_secret/u);
  assert.match(CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY, /vault\.update_secret/u);
  assert.match(
    CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY,
    /decrypted_secret is distinct from \$1::text/u,
  );
  assert.match(
    CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY,
    /decrypted_secret is distinct from \$2::text/u,
  );
  assert.match(CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY, /cron\.schedule/u);
  assert.match(CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY, /cron\.alter_job/u);
  assert.doesNotMatch(
    CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY,
    /(?:insert\s+into|update|delete\s+from)\s+cron\.job/iu,
  );
  for (const query of [EXTENSION_SETUP_QUERY, CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY]) {
    assert.doesNotMatch(query, /grant\s+.*\s+to\s+public/iu);
  }
  assert.doesNotMatch(
    VERIFY_PROFILE_PHOTO_CLEANUP_QUERY,
    /\b(?:insert|update|delete|create|alter|drop|grant|revoke|truncate)\b/iu,
  );
});

test("the stored Cron command contains only Vault references, not protected values or an origin", () => {
  assert.equal(
    (PROFILE_PHOTO_CLEANUP_CRON_COMMAND.match(/vault\.decrypted_secrets/gu) ?? []).length,
    2,
  );
  assert.match(PROFILE_PHOTO_CLEANUP_CRON_COMMAND, /profile_photo_project_url/u);
  assert.match(PROFILE_PHOTO_CLEANUP_CRON_COMMAND, /profile_photo_worker_secret/u);
  assert.match(
    PROFILE_PHOTO_CLEANUP_CRON_COMMAND,
    /\/functions\/v1\/process-profile-photo-cleanup/u,
  );
  assert.doesNotMatch(PROFILE_PHOTO_CLEANUP_CRON_COMMAND, /https?:\/\//iu);
  assert.doesNotMatch(PROFILE_PHOTO_CLEANUP_CRON_COMMAND, new RegExp(projectRef, "u"));
  assert.doesNotMatch(CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY, new RegExp(projectUrl, "u"));
  assert.doesNotMatch(CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY, new RegExp(workerSecret, "u"));
  assert.match(CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY, /\$1::text/u);
  assert.match(CONFIGURE_PROFILE_PHOTO_CLEANUP_QUERY, /\$2::text/u);
  assert.match(VERIFY_PROFILE_PHOTO_CLEANUP_QUERY, /job\.command !~\* 'https\?:\/\/'/u);
});

test("response parsers accept only exact credential-free shapes", () => {
  assert.equal(parseExtensionSetupResponse([]), true);
  assert.equal(parseConfigurationResponse([{ configured: true }]), true);
  assert.equal(parseVerificationResponse([exactVerification()]), true);

  for (const invalid of [null, {}, [{ configured: true }], [{ ...exactVerification(), extra: true }]]) {
    assert.throws(
      () => parseVerificationResponse(invalid),
      /unexpected response shape/u,
    );
  }
  for (const invalid of [null, {}, [true], [{ configured: false }], [{ configured: true, extra: true }]]) {
    assert.throws(
      () => parseConfigurationResponse(invalid),
      /unexpected response shape/u,
    );
  }
  for (const invalid of [null, {}, [true], [{ command: "secret" }]]) {
    assert.throws(
      () => parseExtensionSetupResponse(invalid),
      /unexpected response shape/u,
    );
  }
});

test("verification fails closed for wrong counts, false checks, and wrong field types", () => {
  for (const result of [
    exactVerification({ job_count: 0 }),
    exactVerification({ project_url_secret_count: 2 }),
    exactVerification({ worker_secret_matches: false }),
    exactVerification({ job_active: false }),
    exactVerification({ job_count: "1" }),
  ]) {
    assert.throws(
      () => parseVerificationResponse([result]),
      /unexpected response shape|did not match the fixed policy/u,
    );
  }
});

test("invalid protected inputs fail before any request", async () => {
  const invalidOptions = [
    { accessToken: "" },
    { accessToken: ` ${accessToken}` },
    { accessToken: `${accessToken}\n` },
    { projectRef: "abcdefghijklmnopqrst" },
    { projectUrl: "http://mimolwojppbtsbvtqwpo.supabase.co" },
    { projectUrl: `${projectUrl}/rest/v1` },
    { projectUrl: `https://other.example.com` },
    { workerSecret: "too-short" },
    { workerSecret: `${workerSecret}\n` },
    { fetchImplementation: null },
    { signalFactory: null },
  ];

  for (const override of invalidOptions) {
    let fetchCalled = false;
    const error = await captureRejection(
      configureProductionProfilePhotoCleanupCron(options({
        fetchImplementation: async () => {
          fetchCalled = true;
          return response([]);
        },
        ...override,
      })),
    );
    assert.equal(fetchCalled, false);
    assert.doesNotMatch(error.message, new RegExp(workerSecret, "u"));
    assert.doesNotMatch(error.message, new RegExp(accessToken, "u"));
  }
});

test("HTTP and network failures discard bodies and never expose credentials", async () => {
  let bodyCancelled = false;
  let jsonRead = false;
  const httpError = await captureRejection(
    configureProductionProfilePhotoCleanupCron(options({
      fetchImplementation: async () => response(null, {
        status: 403,
        body: {
          cancel: async () => {
            bodyCancelled = true;
          },
        },
      }),
    })),
  );
  assert.equal(bodyCancelled, true);
  assert.match(httpError.message, /HTTP 403/u);
  assert.doesNotMatch(httpError.message, new RegExp(accessToken, "u"));
  assert.doesNotMatch(httpError.message, new RegExp(workerSecret, "u"));

  const networkError = await captureRejection(
    configureProductionProfilePhotoCleanupCron(options({
      fetchImplementation: async () => {
        throw new Error(`${accessToken}:${workerSecret}:${projectUrl}`);
      },
    })),
  );
  assert.match(networkError.message, /Management API request failed/u);
  assert.doesNotMatch(networkError.message, new RegExp(accessToken, "u"));
  assert.doesNotMatch(networkError.message, new RegExp(workerSecret, "u"));

  const invalidJsonError = await captureRejection(
    configureProductionProfilePhotoCleanupCron(options({
      fetchImplementation: async () => ({
        status: 201,
        redirected: false,
        json: async () => {
          jsonRead = true;
          throw new Error(`${workerSecret}:${projectUrl}`);
        },
      }),
    })),
  );
  assert.equal(jsonRead, true);
  assert.match(invalidJsonError.message, /not valid JSON/u);
  assert.doesNotMatch(invalidJsonError.message, new RegExp(workerSecret, "u"));
});

test("redirects and undocumented success statuses fail closed", async () => {
  for (const responseOptions of [
    { status: 302 },
    { status: 200 },
    { status: 201, redirected: true },
  ]) {
    await assert.rejects(
      configureProductionProfilePhotoCleanupCron(options({
        fetchImplementation: async () => response([], responseOptions),
      })),
      /Management API request was rejected/u,
    );
  }
});

test("repeated runs remain idempotent and issue the same bounded three-request plan", async () => {
  const requestBodies = [];
  let requestIndex = 0;
  const values = [[], [{ configured: true }], [exactVerification()]];
  const fetchImplementation = async (_url, request) => {
    requestBodies.push(JSON.parse(request.body));
    const value = values[requestIndex % values.length];
    requestIndex += 1;
    return response(value);
  };

  await configureProductionProfilePhotoCleanupCron(options({ fetchImplementation }));
  await configureProductionProfilePhotoCleanupCron(options({ fetchImplementation }));
  assert.equal(requestBodies.length, 6);
  assert.deepEqual(requestBodies.slice(0, 3), requestBodies.slice(3));
});

test("the protected release orders hosted setup after migration, secret sync, and worker deploy", async () => {
  const [workflow, ciWorkflow, packageSource] = await Promise.all([
    readFile(path.join(repositoryRoot, ".github", "workflows", "deploy.yml"), "utf8"),
    readFile(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);
  const backendStart = workflow.indexOf("  backend:");
  const frontendStart = workflow.indexOf("  frontend:");
  const backend = workflow.slice(backendStart, frontendStart);
  const completedHistory = backend.indexOf("name: Require exact completed migration history");
  const secretSync = backend.indexOf("name: Synchronize Edge Function secrets");
  const workerDeploy = backend.indexOf("name: Deploy profile-photo cleanup worker");
  const hostedSetup = backend.indexOf(
    "name: Configure and verify profile-photo cleanup Cron",
  );
  const hostedVerification = backend.indexOf("name: Verify deployed functions");
  const workerHealth = backend.indexOf("profile_photo_cleanup_status", hostedVerification);

  assert.ok(
    completedHistory !== -1
      && secretSync !== -1
      && workerDeploy !== -1
      && hostedSetup !== -1
      && hostedVerification !== -1
      && workerHealth !== -1
      && completedHistory < secretSync
      && secretSync < workerDeploy
      && workerDeploy < hostedSetup
      && hostedSetup < hostedVerification
      && hostedVerification < workerHealth,
  );
  assert.match(
    backend,
    /node scripts\/configure-production-profile-photo-cleanup-cron\.mjs/u,
  );
  assert.match(backend, /BILLING_ENABLED: "false"/u);
  assert.match(
    ciWorkflow,
    /run: pnpm run test:production-profile-photo-cleanup-cron/u,
  );
  assert.equal(
    packageJson.scripts["test:production-profile-photo-cleanup-cron"],
    "node --test scripts/configure-production-profile-photo-cleanup-cron.test.mjs",
  );
});
