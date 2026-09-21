import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createAdminPreview } from './admin-preview.mjs';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
test('admin route is registered, no-JS safe and privately non-cacheable', () => {
  assert.equal(PRODUCTION_ENTRYPOINTS.admin, 'admin.html');
  const html = read('../../admin.html'); const headers = read('../../public/_headers');
  assert.match(html, /id="adminWorkspace"[^>]*hidden inert/); assert.match(html, /<tbody id="adminUsersRows" role="rowgroup"><\/tbody>/);
  assert.match(html, /noindex, nofollow, noarchive/); assert.match(html, /<noscript>/);
  for (const path of ['/admin', '/admin.html']) {
    const rule = headers.split('\n\n').find((entry) => entry.startsWith(`${path}\n`));
    assert.match(rule || '', /Cache-Control: private, no-store/); assert.match(rule, /Referrer-Policy: no-referrer/);
  }
});
test('admin controller never persists or interpolates private record payloads', () => {
  const source = read('./admin.js');
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|console\./);
  assert.match(source, /subscribeToAdminInvalidation\(scrub\)/); assert.match(source, /pagehide/); assert.match(source, /event.persisted/);
  const api = read('./api.js'); const adapter = api.slice(api.indexOf('let adminReadClient'), api.indexOf('export function getCurrentAppPath'));
  assert.match(adapter, /cache: 'no-store'/); assert.match(adapter, /credentials: 'omit'/); assert.doesNotMatch(adapter, /service_role|user_metadata/);
  assert.match(adapter, /ENABLE_MOCKS && !usesSupabaseAuthentication\(\)/);
  const menu = read('./menu.js');
  assert.doesNotMatch(menu, /\$\{profileLabel\}|\$\{profileSubtext\}/);
  assert.match(menu, /context.adminReady/); assert.match(menu, /context.permissions.some/);
});
test('synthetic preview requires a signed-in actor and defaults fail closed', async () => {
  const getUser = async () => ({ userId: 'A', authenticated: true });
  const member = createAdminPreview({ getUser, mode: 'member' });
  assert.equal((await member.read('get_site_admin_context')).adminReady, false);
  await assert.rejects(member.read('site_admin_list_users'), { code: 'ADMIN_DENIED' });
  const ready = createAdminPreview({ getUser, mode: 'ready' });
  await assert.rejects(ready.read('site_admin_list_users', {}, { expectedUserId: 'B' }), { code: 'ADMIN_CHANGED' });
  await assert.rejects(createAdminPreview({ getUser: async () => null, mode: 'ready' }).owner(), { code: 'ADMIN_SIGNED_OUT' });
});
test('preview pagination and filters remain server-contract-shaped and query bound', async () => {
  const preview = createAdminPreview({ getUser: async () => ({ userId: 'A', authenticated: true }), mode: 'ready' });
  const args = { target_limit: 25, target_search: '', target_role: 'all', target_status: 'all', target_sort: 'newest', target_cursor: null };
  const first = await preview.read('site_admin_list_users', args); assert.equal(first.items.length, 25); assert.equal(first.preview, true);
  const next = await preview.read('site_admin_list_users', { ...args, target_cursor: first.nextCursor }); assert.equal(next.items.length, 3);
  await assert.rejects(preview.read('site_admin_list_users', { ...args, target_status: 'suspended', target_cursor: first.nextCursor }), { code: 'ADMIN_INVALID_CURSOR' });
});
