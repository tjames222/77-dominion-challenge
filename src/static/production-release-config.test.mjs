import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = read('../../.github/workflows/deploy.yml');
const workflows = [
  workflow,
  read('../../.github/workflows/ci.yml'),
  read('../../.github/workflows/browser-quality.yml'),
];
const headers = read('../../public/_headers');
const setup = read('../../CLOUDFLARE_PAGES_SETUP.md');
const functionEnvironmentExample = read('../../supabase/.env.example');
const authCanaryVerifier = read('../../scripts/verify-production-auth-canary.mjs');
const canaryRunbook = read('../../docs/production-canary-operator-runbook.md');
const localProductionRunner = read('../../scripts/rehearse-local-production-stack.sh');
const localProductionSpec = read('../../tests/e2e/local-production-stack.spec.mjs');
const defaultPlaywrightConfig = read('../../playwright.config.mjs');

describe('production release configuration', () => {
  test('requires an explicit release from the protected main branch', () => {
    assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
    assert.doesNotMatch(workflow, /\n\s+push:\s*\n/);
    assert.match(workflow, /GITHUB_REF[\s\S]*?refs\/heads\/main/);
    assert.match(workflow, /if: inputs\.release_scope == 'full'/);
    assert.match(workflow, /inputs\.release_scope == 'frontend-only'/);
  });

  test('pins every third-party workflow action to an immutable commit', () => {
    for (const source of workflows) {
      const externalActions = [...source.matchAll(/^\s*uses:\s+(?!\.\/)([^@\s]+)@([^\s#]+)/gm)];
      assert.ok(externalActions.length > 0);
      for (const [, action, reference] of externalActions) {
        assert.match(reference, /^[0-9a-f]{40}$/, `${action} must use an immutable commit SHA`);
      }
    }
  });

  test('uses one protected Cloudflare deployment after backend verification', () => {
    assert.match(workflow, /needs:\s*frontend[\s\S]*?environment: production/);
    assert.match(workflow, /cloudflare\/wrangler-action@[0-9a-f]{40} # v3/);
    assert.match(workflow, /pages deploy dist[\s\S]*?--project-name=77-dominion-challenge[\s\S]*?--branch=main/);
    assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
    assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/);
    assert.doesNotMatch(workflow, /deploy-pages|configure-pages|github-pages/);
  });

  test('gates every production release on the closed hosted Auth policy', () => {
    assert.match(workflow, /canary-policy:\s*\n[\s\S]*?environment: production/);
    assert.match(
      workflow,
      /canary-policy:[\s\S]*?node scripts\/verify-production-auth-canary\.mjs/,
    );
    assert.match(
      workflow,
      /backend:[\s\S]*?needs:[\s\S]*?- validation[\s\S]*?- canary-policy/,
    );
    assert.match(
      workflow,
      /frontend:[\s\S]*?needs:[\s\S]*?- canary-policy[\s\S]*?needs\.canary-policy\.result == 'success'/,
    );

    const authGate = workflow.indexOf('canary-policy:');
    const backend = workflow.indexOf('\n  backend:');
    const firstBackendMutation = workflow.indexOf('supabase link --project-ref');
    assert.ok(authGate !== -1 && authGate < backend && backend < firstBackendMutation);

    assert.match(
      authCanaryVerifier,
      /https:\/\/api\.supabase\.com\/v1\/projects/,
    );
    assert.match(authCanaryVerifier, /\/config\/auth/);
    assert.match(authCanaryVerifier, /method: 'GET'/);
    assert.match(authCanaryVerifier, /config\.disable_signup !== true/);
    assert.match(
      authCanaryVerifier,
      /config\.external_anonymous_users_enabled !== false/,
    );
    assert.doesNotMatch(authCanaryVerifier, /\bcurl\b|execFile|spawn/);
    assert.doesNotMatch(authCanaryVerifier, /console\.(?:log|error)\([^\n]*(?:config|response)/);
  });

  test('fails production closed for mocks, signup, billing, and provider connections', () => {
    assert.match(workflow, /CF_PAGES: "1"/);
    assert.match(workflow, /CF_PAGES_BRANCH: main/);
    assert.match(workflow, /VITE_ENABLE_MOCKS: "false"/);
    assert.match(workflow, /VITE_ENABLE_PRODUCTION_CONNECTIONS: "true"/);
    assert.match(workflow, /Production builds must explicitly enable production connections/);
    assert.match(workflow, /VITE_ENABLE_GROUP_INTEGRATIONS: "false"/);
    assert.match(workflow, /Slack and Discord must remain safely off/);
    assert.match(workflow, /VITE_ENABLE_BILLING: "false"/);
    assert.match(workflow, /Billing must remain disabled for the production canary/);
    assert.match(workflow, /VITE_ENABLE_PUBLIC_SIGNUP: "false"/);
    assert.match(workflow, /Public signup must remain disabled for the production canary/);
    assert.match(setup, /turn off[\s\S]*Enable automatic production branch deployments/i);
  });

  test('defers Stripe while preserving gateway auth and disabled billing proofs', () => {
    assert.match(workflow, /BILLING_ENABLED: "false"/);
    assert.match(functionEnvironmentExample, /^BILLING_ENABLED=false$/m);
    const backendJobEnvironment = workflow.slice(
      workflow.indexOf('\n  backend:'),
      workflow.indexOf('\n    steps:', workflow.indexOf('\n  backend:')),
    );
    assert.doesNotMatch(backendJobEnvironment, /STRIPE_/);

    const requiredValues = workflow.match(
      /required=\(\n([\s\S]*?)\n\s*\)\n\s*if \[\[ "\$\{BILLING_ENABLED\}" != "true"/,
    )?.[1];
    assert.ok(requiredValues, 'production base required-value list must be present');
    assert.doesNotMatch(requiredValues, /STRIPE_/);
    assert.match(
      workflow,
      /name: Validate enabled billing configuration\s*\n\s*if: env\.BILLING_ENABLED == 'true'[\s\S]*?STRIPE_SECRET_KEY: \$\{\{ secrets\.STRIPE_SECRET_KEY \}\}[\s\S]*?STRIPE_WEBHOOK_SECRET: \$\{\{ secrets\.STRIPE_WEBHOOK_SECRET \}\}[\s\S]*?STRIPE_MEMBERSHIP_PRICE_ID: \$\{\{ secrets\.STRIPE_MEMBERSHIP_PRICE_ID \}\}/,
    );
    assert.match(workflow, /"BILLING_ENABLED=\$\{BILLING_ENABLED\}"/);
    assert.match(
      workflow,
      /name: Synchronize enabled Stripe Function secrets\s*\n\s*if: env\.BILLING_ENABLED == 'true'[\s\S]*?supabase secrets set[\s\S]*?STRIPE_SECRET_KEY[\s\S]*?STRIPE_WEBHOOK_SECRET[\s\S]*?STRIPE_MEMBERSHIP_PRICE_ID/,
    );
    assert.ok(
      workflow.indexOf('name: Validate enabled billing configuration')
        < workflow.indexOf('supabase link --project-ref'),
      'enabled billing secrets must be validated before the first backend mutation',
    );

    const guardedBillingFunctions = [
      'cancel-membership',
      'create-checkout-session',
      'create-customer-portal-session',
      'stripe-webhook',
    ];
    for (const functionName of guardedBillingFunctions) {
      assert.match(
        workflow,
        new RegExp(`supabase functions deploy ${functionName} --project-ref`),
      );
    }
    for (const functionName of guardedBillingFunctions.slice(0, 3)) {
      const deploymentLine = workflow
        .split('\n')
        .find((line) => line.includes(`functions deploy ${functionName} `));
      assert.ok(deploymentLine);
      assert.doesNotMatch(deploymentLine, /--no-verify-jwt/);
    }
    assert.match(
      workflow,
      /supabase functions deploy stripe-webhook[^\n]*--no-verify-jwt/,
    );

    const authenticatedBillingSmoke = workflow.match(
      /for billing_function in \\\n([\s\S]*?)\n\s*done/,
    )?.[1];
    assert.ok(authenticatedBillingSmoke, 'authenticated billing smoke loop must be present');
    for (const functionName of guardedBillingFunctions.slice(0, 3)) {
      assert.match(authenticatedBillingSmoke, new RegExp(functionName));
    }
    assert.match(workflow, /billing_status[\s\S]*?!= "401"/);
    assert.match(workflow, /unauthenticated \$\{billing_function\} gateway smoke test/);
    assert.match(
      workflow,
      /if \[\[ "\$\{BILLING_ENABLED\}" == "false" \]\]; then\s*webhook_expected_status="503"/,
    );
    assert.match(workflow, /webhook_status[\s\S]*?!= "\$webhook_expected_status"/);
    assert.match(workflow, /functions\/v1\/stripe-webhook/);
    assert.doesNotMatch(workflow, /cat [^\n]*(?:billing|stripe).*response/i);
  });

  test('documents a UUID-bound, expiring, auditable canary grant and rollback', () => {
    assert.match(canaryRunbook, /target Auth user UUID/i);
    assert.match(canaryRunbook, /'membership_active'/);
    assert.match(canaryRunbook, /'production_canary'/);
    assert.match(canaryRunbook, /interval '2 hours'/);
    assert.match(canaryRunbook, /grant_start timestamptz := statement_timestamp\(\)/);
    assert.match(canaryRunbook, /real (?:browser )?session/i);
    assert.match(canaryRunbook, /cancel-membership[\s\S]*create-checkout-session[\s\S]*create-customer-portal-session[\s\S]*exact `503`/i);
    assert.match(canaryRunbook, /canary_grant_id/);
    assert.match(canaryRunbook, /billing_customers/);
    assert.match(canaryRunbook, /subscriptions/);
    assert.match(canaryRunbook, /legacy `purchases`/);
    assert.match(canaryRunbook, /status = 'revoked'/);
    assert.match(canaryRunbook, /frontend-only/);
    assert.match(canaryRunbook, /roll forward[\s\S]*Never reset hosted/i);
  });

  test('builds the frontend for the same Supabase project migrated by the backend', () => {
    assert.match(workflow, /SUPABASE_PROJECT_REF: \$\{\{ vars\.SUPABASE_PROJECT_REF \}\}/);
    assert.equal(
      workflow.match(/expected_supabase_url="https:\/\/\$\{SUPABASE_PROJECT_REF\}\.supabase\.co"/g)?.length,
      2,
      'backend and frontend must both reject a cross-project configuration',
    );
    assert.match(workflow, /VITE_SUPABASE_URL%\//);
    assert.match(workflow, /PUBLIC_SITE_URL must be an HTTPS production origin/);
  });

  test('deploys and smoke-tests every authenticated release function', () => {
    for (const functionName of [
      'cancel-membership',
      'create-checkout-session',
      'create-customer-portal-session',
      'reward-download',
      'retired-community-export',
      'upload-profile-photo',
    ]) {
      assert.match(
        workflow,
        new RegExp(`supabase functions deploy ${functionName} --project-ref`),
      );
    }
    assert.match(workflow, /functions\/v1\/reward-download/);
    assert.match(workflow, /reward_download_status[\s\S]*?!= "401"/);
    assert.match(workflow, /functions\/v1\/upload-profile-photo/);
    assert.match(workflow, /profile_upload_status[\s\S]*?!= "401"/);
  });

  test('ships restrictive Cloudflare security headers', () => {
    for (const header of [
      'Content-Security-Policy',
      'Strict-Transport-Security',
      'Referrer-Policy',
      'Permissions-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ]) assert.match(headers, new RegExp(`${header}:`));
    assert.match(headers, /script-src 'self'/);
    assert.match(headers, /frame-ancestors 'none'/);
    assert.match(headers, /connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co/);
    assert.doesNotMatch(headers, /script-src\s+'unsafe-inline'/);
  });

  test('binds the destructive local rehearsal to the exact repository stack', () => {
    assert.match(localProductionRunner, /DOMINION_ALLOW_LOCAL_RESET:-.*== "true"/);
    assert.match(
      localProductionRunner,
      /project_id=[\s\S]*supabase\/config\.toml[\s\S]*local_postgres_container="supabase_db_\$\{project_id\}"/,
    );
    assert.match(
      localProductionRunner,
      /LOCAL_POSTGRES_CONTAINER:-[\s\S]*!= "\$local_postgres_container"[\s\S]*must equal/,
    );
    assert.doesNotMatch(localProductionRunner, /LOCAL_POSTGRES_CONTAINER:-supabase_db_/);
    assert.match(localProductionRunner, /export DOCKER_BIN="\$local_docker_bin"/);
    assert.match(
      localProductionRunner,
      /export SUPABASE_DB_CONTAINER="\$local_postgres_container"/,
    );
    assert.match(localProductionRunner, /com\.supabase\.cli\.project/);
    assert.match(localProductionRunner, /com\.docker\.compose\.project/);
    assert.match(localProductionRunner, /actual_postgres_image[\s\S]*expected_postgres_image_ref/);

    const telemetryGuard = localProductionRunner.indexOf('export SUPABASE_TELEMETRY_DISABLED=1');
    const cliVersionCheck = localProductionRunner.indexOf('$supabase_cli --version');
    const dockerBinding = localProductionRunner.indexOf('export DOCKER_BIN="$local_docker_bin"');
    const databaseReset = localProductionRunner.indexOf('scripts/reset-local-database.sh');
    const ownershipPreflight = localProductionRunner.indexOf('# A same-name container');
    assert.ok(
      telemetryGuard !== -1
        && cliVersionCheck !== -1
        && telemetryGuard < cliVersionCheck,
    );
    assert.ok(dockerBinding !== -1 && databaseReset !== -1 && dockerBinding < databaseReset);
    assert.ok(
      ownershipPreflight !== -1
        && ownershipPreflight < databaseReset
        && localProductionRunner
          .slice(ownershipPreflight, databaseReset)
          .includes('verify_local_database_container'),
      'container ownership must be proven before the reset',
    );
    assert.ok(
      localProductionRunner.slice(databaseReset).includes('verify_local_database_container'),
      'container ownership must be rechecked after the reset',
    );
  });

  test('intercepts all hosted browser traffic during the local rehearsal', () => {
    assert.match(localProductionSpec, /context\.route\('\*\*\/\*'/);
    assert.match(localProductionSpec, /allowedHttpOrigins\.has\(requestUrl\.origin\)/);
    assert.match(localProductionSpec, /route\.fulfill\(\{/);
    assert.match(localProductionSpec, /route\.abort\('blockedbyclient'\)/);
    assert.match(localProductionSpec, /context\.routeWebSocket\(\/\^wss\?/);
    assert.match(localProductionSpec, /allowedWebSocketOrigins\.has\(requestUrl\.origin\)/);
    assert.match(localProductionSpec, /webSocket\.connectToServer\(\)/);
    assert.match(localProductionSpec, /unexpectedHostedRequests[\s\S]*toEqual\(\[\]\)/);
    assert.match(
      localProductionSpec,
      /https:\/\/pub-53499389187a4de4984349b4f9b36b74\.r2\.dev\/photo_1783730958\.105418\.png/,
    );
  });

  test('runs the destructive local rehearsal only through its dedicated config', () => {
    assert.match(defaultPlaywrightConfig, /local-production-stack\\\.spec\\\.mjs/);
    assert.match(
      read('../../playwright.local-production.config.mjs'),
      /testMatch: \/local-production-stack\\\.spec\\\.mjs\//,
    );
  });
});
