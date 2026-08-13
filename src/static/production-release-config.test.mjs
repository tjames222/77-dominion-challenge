import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = read('../../.github/workflows/deploy.yml');
const headers = read('../../public/_headers');
const setup = read('../../CLOUDFLARE_PAGES_SETUP.md');

describe('production release configuration', () => {
  test('uses one protected Cloudflare deployment after backend verification', () => {
    assert.match(workflow, /needs:\s*frontend[\s\S]*?environment: production/);
    assert.match(workflow, /cloudflare\/wrangler-action@v3/);
    assert.match(workflow, /pages deploy dist[\s\S]*?--project-name=77-dominion-challenge[\s\S]*?--branch=main/);
    assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
    assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/);
    assert.doesNotMatch(workflow, /deploy-pages|configure-pages|github-pages/);
  });

  test('fails production closed for mocks and provider connections', () => {
    assert.match(workflow, /VITE_ENABLE_MOCKS: "false"/);
    assert.match(workflow, /VITE_ENABLE_GROUP_INTEGRATIONS: "false"/);
    assert.match(workflow, /Slack and Discord must remain safely off/);
    assert.match(setup, /turn off[\s\S]*Enable automatic production branch deployments/i);
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
