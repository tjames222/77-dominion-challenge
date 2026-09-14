import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAdminMenuReadRoute } from './admin-menu-route.mjs';

test('Admin menu reads exclude exact normalized authentication entry routes', () => {
  for (const route of ['login', 'register', 'forgot-password', 'reset-password', 'account-security']) {
    for (const path of [`/${route}`, `/${route}.html`, `/${route}/`, `/nested/${route}.html?returnTo=./support.html#ignored`]) {
      assert.equal(isAdminMenuReadRoute(path), false, path);
    }
  }
});

test('Admin menu route admission preserves Support and authenticated routes without substring matching', () => {
  for (const path of ['', '/', '/support', '/support.html', '/admin', '/admin.html', '/dashboard.html', '/profile', '/index.html', '/login-help.html', '/support?returnTo=/login.html', '/support#register.html']) {
    assert.equal(isAdminMenuReadRoute(path), true, path);
  }
});
