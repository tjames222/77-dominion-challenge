import assert from 'node:assert/strict';
import test from 'node:test';
import main from '../../playwright.config.mjs';
import admin from '../../playwright.admin.config.mjs';

const suites = ['admin-live.spec.mjs', 'admin-early-access-live.spec.mjs', 'admin-roles-live.spec.mjs'];
const matches = (patterns, file) => [patterns].flat().filter(Boolean).some((pattern) => {
  assert.ok(pattern instanceof RegExp, 'These suite boundaries use explicit regular expressions');
  return pattern.test(file);
});

test('main mock-server projects exclude every production-only Admin suite', () => {
  for (const file of suites) for (const project of main.projects) {
    const selection = project.testMatch ?? main.testMatch;
    const ignored = matches(project.testIgnore ?? main.testIgnore, file);
    assert.ok(ignored || (selection && !matches(selection, file)), `${project.name} must not discover ${file}`);
  }
  const functional = main.projects.find((project) => project.name === 'chromium-functional');
  for (const file of suites) assert.ok(matches(functional.testIgnore, file), `Explicit functional exclusion required for ${file}`);
});

test('production-built Admin configuration exclusively selects the three live Admin suites', () => {
  for (const file of suites) assert.ok(matches(admin.testMatch, file), `${file} belongs to the Admin gate`);
  for (const file of ['admin-preview.spec.mjs', 'mfa-live-auth.spec.mjs', 'visual-routes.spec.mjs']) assert.equal(matches(admin.testMatch, file), false);
  assert.deepEqual(admin.projects.map((project) => project.name), ['admin-live-chromium', 'admin-live-webkit']);
});

test('Admin discovery remains attached to a production build, not the main mock server', () => {
  assert.match(admin.webServer.command, /vite build/); assert.match(admin.webServer.command, /vite preview/);
  assert.equal(admin.webServer.env.VITE_ENABLE_MOCKS, 'false');
  assert.equal(admin.webServer.env.VITE_ENABLE_PRODUCTION_CONNECTIONS, 'true');
  assert.equal(admin.webServer.env.VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS, 'false');
});
