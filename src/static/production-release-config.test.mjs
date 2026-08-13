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

  test('fails production closed for mocks and provider connections', () => {
    assert.match(workflow, /CF_PAGES: "1"/);
    assert.match(workflow, /CF_PAGES_BRANCH: main/);
    assert.match(workflow, /VITE_ENABLE_MOCKS: "false"/);
    assert.match(workflow, /VITE_ENABLE_GROUP_INTEGRATIONS: "false"/);
    assert.match(workflow, /Slack and Discord must remain safely off/);
    assert.match(setup, /turn off[\s\S]*Enable automatic production branch deployments/i);
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
});
