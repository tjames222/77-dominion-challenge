import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installProfileNameStub, PROFILE_TARGET, PROFILE_VERSION } from './support/admin-profile-name-stub.mjs';

const correction = 'Zoë 李 👩🏽‍💻';
const id = name => `#adminProfileName${name}`;
async function ready(page) { await page.goto('/admin.html'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); }
async function detail(page) {
  await page.getByRole('button', { name: 'View details for Preview Member 28', exact: true }).click();
  await expect(page.locator('#adminUserFacts')).toContainText(PROFILE_TARGET);
}
async function review(page) { await detail(page); await page.locator(id('Review')).click(); await expect(page.locator(id('Form'))).toBeVisible(); }
async function choose(page, name = correction) { await page.locator(id('Input')).fill(name); await page.locator(id('Acknowledgement')).check(); }
async function submit(page, name = correction) { await choose(page, name); await page.locator(id('Confirm')).click(); }
async function noStoredIntent(page) {
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toMatch(/target_expected_version|target_operation_id|target_correlation_id|profile_name_correction|Zoë|PRIVATE PROFILE|72000000/);
  expect(page.url()).not.toMatch(/target_name|Zo%C3%AB|72000000/);
}
async function announceSession(page, sessions) {
  await page.evaluate(async values => {
    const channel = new BroadcastChannel('sb-127-auth-token');
    for (const session of values) {
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
      window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(session) }));
      channel.postMessage({ event: 'SIGNED_IN', session }); await new Promise(resolve => setTimeout(resolve, 0));
    }
    channel.close();
  }, sessions);
}
test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort());
  await context.routeWebSocket('**/*', socket => socket.close());
});

test('only users.read plus users.manage exposes correction; opening details never preloads or writes a name', async ({ page, context }) => {
  const auth = await installProfileNameStub(context, { permissions: ['users.read', 'audit.read'] }); await ready(page); await detail(page);
  await expect(page.locator(id('Review'))).toHaveCount(0); expect(auth.profileReads()).toHaveLength(0); expect(auth.corrections()).toHaveLength(0);
  auth.permissions(['users.manage']); await page.reload(); await expect(page.locator('#adminWorkspace')).toBeHidden(); expect(auth.corrections()).toHaveLength(0);
});
test('exact reviewed intent needs acknowledgement after every edit and returns a metadata-only receipt', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page);
  expect(auth.profileReads()).toHaveLength(1); expect(auth.corrections()).toHaveLength(0);
  await expect(page.locator(id('Current'))).toHaveText('Current name at review: Preview Member 28');
  await expect(page.locator(id('Confirm'))).toBeDisabled(); await choose(page, 'Review first');
  await page.locator(id('Input')).fill(correction); await expect(page.locator(id('Acknowledgement'))).not.toBeChecked();
  await expect(page.locator(id('Confirm'))).toBeDisabled(); await page.locator(id('Acknowledgement')).check();
  await page.locator(id('Confirm')).click(); await expect(page.locator(id('Status'))).toContainText('Confirmed original operation: display name corrected');
  expect(auth.corrections()).toHaveLength(1); const sent = auth.corrections()[0].body;
  expect(Object.keys(sent).sort()).toEqual(['target_correlation_id', 'target_expected_actor_id', 'target_expected_version', 'target_name', 'target_operation_id', 'target_user_id']);
  expect(sent.target_name).toBe(correction); expect(sent.target_expected_version).toBe(PROFILE_VERSION); expect(sent.target_user_id).toBe(PROFILE_TARGET);
  expect(sent.target_expected_actor_id).toBe(auth.A); expect(sent.target_operation_id).not.toBe(sent.target_correlation_id);
  await expect(page.locator(id('Status'))).toContainText(sent.target_operation_id); await expect(page.locator(id('Status'))).toContainText(sent.target_correlation_id);
  await expect(page.locator(id('Status'))).not.toContainText(correction); await expect(page.locator(id('Input'))).toHaveValue('');
  await expect(page.locator('#adminUserFacts')).not.toContainText(correction); expect(auth.profileReads()).toHaveLength(1);
  expect(JSON.stringify(auth.events)).not.toContain(correction); expect(auth.responses.at(-1)).not.toHaveProperty('name');
  await page.locator(id('Refresh')).click(); await expect(page.locator(id('RefreshStatus'))).toContainText(`Current profile name: ${correction}`);
  expect(auth.profileReads()).toHaveLength(2); expect(auth.corrections()).toHaveLength(1);
  await page.locator(id('Reload')).click(); await expect(page.locator(id('Review'))).toBeVisible();
  await page.locator('#adminUserHistory > summary').click(); await expect(page.locator('#adminUserHistoryRows')).toContainText('Names are not retained in this audit');
  await expect(page.locator('#adminUserHistoryRows')).not.toContainText(correction); await expect(page.locator('#adminUserHistoryRows')).not.toContainText('Preview Member 28');
  expect(auth.corrections()).toHaveLength(1); await noStoredIntent(page);
});
test('unchanged name is an explicit no-op receipt retaining the reviewed version', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); await page.locator(id('Acknowledgement')).check();
  await page.locator(id('Confirm')).click(); await expect(page.locator(id('Status'))).toContainText('no name change was needed');
  expect(auth.profile().version).toBe(PROFILE_VERSION); expect(auth.events).toHaveLength(1); expect(auth.events[0].profileNameChanged).toBe(false); await noStoredIntent(page);
});
test('unsupported input never trims or submits and legacy unavailable is never made editable', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page);
  for (const value of [' leading', 'trailing\u00a0', '\ufeffleading', 'x'.repeat(121), 'Line\u2028separator']) {
    await choose(page, value); await expect(page.locator(id('Confirm'))).toBeDisabled(); expect(auth.corrections()).toHaveLength(0);
  }
  await page.locator(id('Cancel')).click(); auth.unavailable('unsupported_legacy_name'); await page.locator(id('Review')).click();
  await expect(page.locator(id('Status'))).toContainText('has not been truncated or changed'); await expect(page.locator(id('Form'))).toBeHidden(); expect(auth.corrections()).toHaveLength(0);
});
for (const reason of ['missing_profile', 'missing_version', 'target_unavailable']) test(`${reason} fails closed without fabricating profile data`, async ({ page, context }) => {
  const auth = await installProfileNameStub(context); auth.unavailable(reason); await ready(page); await detail(page); await page.locator(id('Review')).click();
  await expect(page.locator(id('Reload'))).toBeVisible(); await expect(page.locator(id('Form'))).toBeHidden(); expect(auth.corrections()).toHaveLength(0); await noStoredIntent(page);
});
test('recent MFA is checked before review and again before confirmation without continuation', async ({ page, context }) => {
  const auth = await installProfileNameStub(context, { stepUpRequired: true }); await ready(page); await detail(page); await page.locator(id('Review')).click();
  await expect(page.locator(id('StepUp'))).toBeVisible(); await expect(page.locator(id('StepUp'))).toHaveAttribute('href', /mode=step-up/);
  expect(auth.profileReads()).toHaveLength(0); auth.stepUp(false); await page.reload(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); await review(page); await choose(page);
  auth.stepUp(true); await page.locator(id('Confirm')).click(); await expect(page.locator(id('StepUp'))).toBeVisible(); await expect(page.locator(id('Form'))).toBeHidden();
  expect(auth.corrections()).toHaveLength(0); await noStoredIntent(page);
});
test('lost committed response has no auto-retry; one explicit exact retry returns the original metadata, not a newer name', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await page.clock.install(); await ready(page); await review(page); auth.writeMode('lost'); await submit(page);
  await expect(page.locator(id('Confirm'))).toHaveText('Retry same correction'); await expect(page.locator(id('Input'))).toBeDisabled();
  const original = structuredClone(auth.corrections()[0].body); await page.clock.fastForward(5_000); expect(auth.corrections()).toHaveLength(1);
  auth.changeName('NEWER CURRENT NAME'); await page.locator(id('Confirm')).click(); await expect(page.locator(id('Status'))).toContainText('Confirmed original operation');
  expect(auth.corrections()).toHaveLength(2); expect(auth.corrections()[1].body).toEqual(original); expect(auth.events).toHaveLength(1);
  await expect(page.locator(id('Status'))).not.toContainText('NEWER CURRENT NAME'); await expect(page.locator(id('Status'))).not.toContainText(correction);
  expect(auth.profileReads()).toHaveLength(1); await page.locator(id('Refresh')).click(); await expect(page.locator(id('RefreshStatus'))).toContainText('NEWER CURRENT NAME');
  expect(auth.corrections()).toHaveLength(2); await noStoredIntent(page);
});
test('rate limiting preserves an exact explicit retry and does not create a receipt until accepted', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); auth.writeMode('rate_limited'); await submit(page);
  await expect(page.locator(id('Status'))).toContainText('administration limit'); await expect(page.locator(id('Confirm'))).toHaveText('Retry same correction'); expect(auth.events).toHaveLength(0);
  const original = structuredClone(auth.corrections()[0].body); await page.locator(id('Confirm')).click(); await expect(page.locator(id('Status'))).toContainText('Confirmed original operation');
  expect(auth.corrections()[1].body).toEqual(original); expect(auth.events).toHaveLength(1);
});
for (const kind of ['concurrent edit', 'same-name ABA']) test(`${kind} conflicts rather than silently rebasing the reviewed correction`, async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); auth.changeName('Intervening name');
  if (kind === 'same-name ABA') auth.changeName('Preview Member 28'); await submit(page);
  await expect(page.locator(id('Status'))).toContainText('name changed during review'); await expect(page.locator(id('Form'))).toBeHidden(); await expect(page.locator(id('Reload'))).toBeVisible();
  expect(auth.corrections()).toHaveLength(1); expect(auth.corrections()[0].body.target_expected_version).toBe(PROFILE_VERSION); expect(auth.profile().name).not.toBe(correction);
  await page.locator(id('Reload')).click(); await expect(page.locator(id('Review'))).toBeVisible(); expect(auth.corrections()).toHaveLength(1); await noStoredIntent(page);
});
for (const mode of ['target_unavailable', 'profile_unavailable', 'invalid_input', 'self_action_forbidden', 'unsupported_legacy_name', 'idempotency']) test(`${mode} ends the decision without mutation replay`, async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); auth.writeMode(mode); await submit(page);
  await expect(page.locator(id('Form'))).toBeHidden(); await expect(page.locator(id('Reload'))).toBeVisible(); expect(auth.corrections()).toHaveLength(1);
  await expect(page.locator('#adminDetailBody')).not.toContainText('PRIVATE PROFILE'); await noStoredIntent(page);
});
for (const mode of ['wrong-operation', 'raw-name']) test(`malformed ${mode} receipt remains uncertain and leaks no raw response`, async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); auth.writeMode(mode); await submit(page);
  await expect(page.locator(id('Confirm'))).toHaveText('Retry same correction'); await expect(page.locator(id('Status'))).not.toContainText('Confirmed original');
  await expect(page.locator('#adminDetailBody')).not.toContainText('PRIVATE RECEIPT'); expect(auth.corrections()).toHaveLength(1);
});
for (const mode of ['wrong-actor', 'raw-legacy']) test(`malformed ${mode} exact-name read never hydrates editable input`, async ({ page, context }) => {
  const auth = await installProfileNameStub(context); auth.readMode(mode); await ready(page); await detail(page); await page.locator(id('Review')).click();
  await expect(page.locator(id('Form'))).toBeHidden(); await expect(page.locator(id('Reload'))).toBeVisible(); expect(auth.corrections()).toHaveLength(0); await noStoredIntent(page);
});
for (const change of ['actor round trip', 'same-account session ABA', 'pagehide']) test(`${change} scrubs a prepared decision and never replays`, async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); await choose(page);
  if (change === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  else await announceSession(page, change === 'actor round trip' ? [auth.session(auth.B), auth.session(auth.A)]
    : [auth.session(auth.A, 'aal2', '22222222-2222-4222-8222-222222222222'), auth.session(auth.A)]);
  await expect(page.locator('#adminDetailBody')).toBeEmpty(); expect(auth.corrections()).toHaveLength(0);
  await page.reload(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); expect(auth.corrections()).toHaveLength(0); await noStoredIntent(page);
});
test('permission revocation before confirmation clears private state and never submits', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); await choose(page); auth.permissions(['users.read', 'audit.read']);
  await page.locator(id('Confirm')).click(); await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  expect(auth.corrections()).toHaveLength(0); await noStoredIntent(page);
});
test('same-account session ABA during the exact-name read cannot repopulate a cleared dialog', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await detail(page);
  const release = auth.holdProfile('site_admin_get_profile_name'); await page.locator(id('Review')).click();
  await expect.poll(() => auth.profileReads().length).toBe(1);
  await announceSession(page, [auth.session(auth.A, 'aal2', '22222222-2222-4222-8222-222222222222'), auth.session(auth.A)]);
  release(); await expect(page.locator('#adminDetailBody')).toBeEmpty(); await expect(page.locator('#adminDetail')).not.toBeVisible();
  expect(auth.corrections()).toHaveLength(0); await noStoredIntent(page);
});
test('revocation observed by a held correction prevents its commit and clears the reviewed name', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); const release = auth.holdProfile();
  await submit(page); await expect.poll(() => auth.corrections().length).toBe(1); auth.permissions(['users.read', 'audit.read']); release();
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetailBody')).toBeEmpty();
  expect(auth.events).toHaveLength(0); expect(auth.profile().version).toBe(PROFILE_VERSION); await noStoredIntent(page);
});
test('a held write has a bounded uncertain result and explicit retry keeps the original IDs', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await page.clock.install(); await ready(page); await review(page);
  const release = auth.holdProfile(); await submit(page); await expect.poll(() => auth.corrections().length).toBe(1); const original = structuredClone(auth.corrections()[0].body);
  await page.clock.fastForward(20_001); await expect(page.locator(id('Confirm'))).toHaveText('Retry same correction'); release();
  await page.locator(id('Confirm')).click(); await expect(page.locator(id('Status'))).toContainText('Confirmed original operation'); expect(auth.corrections()[1].body).toEqual(original); expect(auth.events).toHaveLength(1);
});
for (const boundary of ['deadline', 'pagehide']) test(`a delayed compiled writer chunk cannot submit after ${boundary}`, async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await page.clock.install();
  let release; let chunkUrl = ''; const wait = new Promise(resolve => { release = resolve; });
  await context.route('**/assets/admin-profile-name-write-client-*.js', async route => {
    chunkUrl = route.request().url(); await wait; await route.fallback();
  });
  await ready(page); await review(page); await submit(page); await expect.poll(() => chunkUrl.length).toBeGreaterThan(0);
  expect(auth.corrections()).toHaveLength(0);
  if (boundary === 'deadline') {
    await page.clock.fastForward(20_001); await expect(page.locator(id('Form'))).toBeHidden(); await expect(page.locator(id('Reload'))).toBeVisible();
    await expect(page.locator(id('Status'))).not.toContainText('may already be committed');
  } else {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.locator('#adminDetailBody')).toBeEmpty();
  }
  const loaded = page.waitForResponse(response => response.url() === chunkUrl); release(); await loaded;
  await page.evaluate(async url => { await import(url); }, chunkUrl); await page.clock.fastForward(100);
  expect(auth.corrections()).toHaveLength(0); expect(auth.events).toHaveLength(0); await noStoredIntent(page);
});
test('closing during a write discards its late response; reopening performs no automatic write', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); const release = auth.holdProfile(); await submit(page);
  await expect.poll(() => auth.corrections().length).toBe(1); await page.locator('#adminDetailClose').click(); release();
  await expect(page.locator('#adminDetailBody')).toBeEmpty(); await expect.poll(() => auth.events.length).toBe(1);
  await detail(page); await expect(page.locator(id('Review'))).toBeVisible(); expect(auth.corrections()).toHaveLength(1); await noStoredIntent(page);
});
test('discarding an uncertain review never reuses its operation on the next review', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); auth.writeMode('lost'); await submit(page);
  await expect(page.locator(id('Confirm'))).toHaveText('Retry same correction'); const original = structuredClone(auth.corrections()[0].body);
  await page.locator(id('Cancel')).click(); await expect(page.locator(id('Status'))).toContainText('may already be committed'); await page.locator(id('Review')).click();
  await expect(page.locator(id('Form'))).toBeVisible(); expect(auth.corrections()).toHaveLength(1); await submit(page, 'Fresh reviewed correction');
  await expect(page.locator(id('Status'))).toContainText('Confirmed original operation'); expect(auth.corrections()[1].body.target_operation_id).not.toBe(original.target_operation_id); await noStoredIntent(page);
});
test('failed manual post-success read retains the truthful original receipt and never writes again', async ({ page, context }) => {
  const auth = await installProfileNameStub(context); await ready(page); await review(page); await submit(page); await expect(page.locator(id('Status'))).toContainText('Confirmed original operation');
  auth.readMode('failure'); await page.locator(id('Refresh')).click(); await expect(page.locator(id('RefreshStatus'))).toContainText('original receipt remains confirmed');
  await expect(page.locator(id('Status'))).toContainText('Confirmed original operation'); await expect(page.locator('#adminDetailBody')).not.toContainText('PRIVATE PROFILE'); expect(auth.corrections()).toHaveLength(1);
});
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) for (const width of [320, 1440]) test(`profile correction is keyboard accessible at ${width}px in ${theme}, including 200% text`, async ({ page, context, browserName }, testInfo) => {
  const auth = await installProfileNameStub(context); await page.setViewportSize({ width, height: 1000 }); await ready(page); await review(page);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme); await choose(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect((await page.locator(id('Input')).boundingBox()).height).toBeGreaterThanOrEqual(48);
  expect((await new AxeBuilder({ page }).include('#adminDetail').analyze()).violations).toEqual([]);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; }); await page.locator(id('Confirm')).scrollIntoViewIfNeeded();
  expect(await page.locator('#adminDetail').evaluate(value => value.scrollWidth <= value.clientWidth + 1)).toBe(true);
  await page.locator(id('Confirm')).focus(); await expect(page.locator(id('Confirm'))).toBeFocused();
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab'); await expect(page.locator(id('Cancel'))).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath(`profile-name-${theme}-${width}-200.png`) });
  await page.keyboard.press('Enter'); await expect(page.locator(id('Form'))).toBeHidden(); await page.keyboard.press('Escape'); await expect(page.locator('#adminDetail')).not.toBeVisible();
  expect(auth.corrections()).toHaveLength(0); await noStoredIntent(page);
});
