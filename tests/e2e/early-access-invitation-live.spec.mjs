import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installAdminStub } from './support/admin-supabase-stub.mjs';

const token = 'A'.repeat(43);
const generationId = '50000000-0000-4000-8000-000000000005';
const routePath = '/early-access-invite.html';
const invitationPath = `${routePath}#token=${token}&generation=${generationId}`;
const storageKey = 'dominion:early-access-invitation:v1';
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
async function fixture(context, { signedOut = false, aal = 'aal2' } = {}) {
  const auth = await installAdminStub(context, { aal });
  const reads = []; const writes = []; const operations = new Map(); let mode = ''; let hold; let holdName;
  await context.addInitScript(({ signedOut }) => {
    if (signedOut) localStorage.removeItem('sb-127-auth-token');
    // Test-only instrumentation records when the real installed Auth runtime
    // first touches its storage key. Fixture seeding has already completed.
    window.__invitationStartup = [];
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'sb-127-auth-token') window.__invitationStartup.push({ kind: 'native-auth-storage', hash: location.hash });
      return getItem.call(this, key);
    };
  }, { signedOut });
  await context.route('**/__admin_fixture__/rest/v1/rpc/{get_member_access_context,accept_early_access_invitation}', async route => {
    const request = route.request(); const name = new URL(request.url()).pathname.split('/').at(-1); const body = request.postDataJSON();
    const bearer = request.headers().authorization?.replace(/^Bearer /, '');
    let claims; try { claims = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url')); } catch { claims = {}; }
    const item = { body, bearer, method: request.method() }; (name === 'get_member_access_context' ? reads : writes).push(item);
    if (hold && holdName === name) await hold;
    if (!claims.sub || body.target_expected_actor_id !== claims.sub) return json(route, { code: 'PT401', message: 'member_authentication_required' }, 401);
    if (claims.aal !== 'aal2') return json(route, { code: 'PT403', message: 'member_mfa_required' }, 403);
    if (name === 'get_member_access_context') return json(route, { schemaVersion: 1, actorId: claims.sub, asOf: new Date().toISOString(),
      appAccess: false, legacyMembershipActive: false, paidSubscriptionActive: false, earlyAccessActive: false,
      earlyAccessProgram: null, earlyAccessEndsAt: null, betaPriceEligible: false });
    const selected = mode; mode = '';
    if (['rate_limited', 'account_unavailable', 'delivery_not_ready', 'invitation_unavailable', 'account_setup_required'].includes(selected)) return json(route, { ok: false, errorCode: selected });
    const fingerprint = JSON.stringify(body); const prior = operations.get(body.target_operation_id);
    if (prior && prior !== fingerprint) return json(route, { code: '22023', message: 'invitation_idempotency_conflict' }, 400);
    operations.set(body.target_operation_id, fingerprint);
    if (selected === 'unknown') return json(route, { code: 'PRIVATE_ERROR', message: 'PRIVATE_TOKEN_RESPONSE' }, 503);
    const receipt = { ok: true, status: 'accepted', actorId: selected === 'wrong-owner' ? auth.B : claims.sub, program: 'early_access_v1' };
    return json(route, receipt);
  });
  return { ...auth, reads, writes, mode(value) { mode = value; }, holdRpc(name) { let release; holdName = name; hold = new Promise(resolve => { release = resolve; }); return () => { release(); hold = null; }; } };
}
async function ready(page) { await page.goto(invitationPath); await expect(page.locator('#earlyAccessAcceptForm')).toBeVisible(); }
async function accept(page) { await page.locator('#earlyAccessAcceptAcknowledgement').check(); await page.locator('#earlyAccessAccept').click(); }
async function replaceSession(page, session, event = 'SIGNED_IN') {
  await page.evaluate(({ session, event }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    const channel = new BroadcastChannel('sb-127-auth-token'); channel.postMessage({ event, session }); channel.close();
  }, { session, event });
}
test('invitation capability is stripped before native Auth starts and opening never accepts', async ({ page, context }) => {
  const auth = await fixture(context); await ready(page);
  await expect(page).toHaveURL(new RegExp(`${routePath}$`));
  const startup = await page.evaluate(() => window.__invitationStartup);
  expect(startup.length).toBeGreaterThan(0); expect(startup.every(event => event.hash === '')).toBe(true);
  expect(auth.writes).toHaveLength(0); await expect(page.locator('#earlyAccessAccept')).toBeDisabled();
  const state = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), storageKey);
  expect(state).toMatchObject({ generationId, token }); expect(Object.keys(state).sort()).toEqual(['capturedAt', 'generationId', 'token']);
  expect(auth.reads.every(item => !JSON.stringify(item.body).includes(token))).toBe(true);
});
test('fresh signed-out visitor sees a plain sign-in continuation, not a dead review loop', async ({ page, context }) => {
  const auth = await fixture(context, { signedOut: true }); await page.goto(invitationPath);
  await expect(page.locator('#earlyAccessSignIn')).toBeVisible(); await expect(page.locator('#earlyAccessAcceptForm')).toBeHidden();
  await expect(page.locator('#earlyAccessInviteStatus')).toContainText('Sign in with the invited email');
  const href = new URL(await page.locator('#earlyAccessSignIn').getAttribute('href'), page.url());
  expect(href.searchParams.get('returnTo')).toBe('./early-access-invite.html'); expect(href.hash).toBe(''); expect(href.href).not.toContain(token);
  expect(auth.writes).toHaveLength(0);
});
test('initial MFA requirement survives synchronous invalidation and returns only to a plain invitation route', async ({ page, context }) => {
  const auth = await fixture(context, { aal: 'aal1' }); await page.goto(invitationPath);
  await expect(page.locator('#earlyAccessMfa')).toBeVisible(); await expect(page.locator('#earlyAccessAcceptForm')).toBeHidden();
  await expect(page.locator('#earlyAccessInviteStatus')).toContainText('Verify your authenticator');
  const href = new URL(await page.locator('#earlyAccessMfa').getAttribute('href'), page.url());
  expect(href.searchParams.get('returnTo')).toBe('./early-access-invite.html'); expect(href.href).not.toContain(token); expect(auth.writes).toHaveLength(0);
});
test('explicit consent sends the exact native-owner acceptance and clears the continuation on success', async ({ page, context }) => {
  const auth = await fixture(context); await ready(page); await accept(page);
  await expect(page.locator('#earlyAccessInviteStatus')).toContainText('Early Access accepted');
  await expect(page.locator('#earlyAccessInviteStatus')).toContainText('No subscription or charge');
  await expect(page.locator('#earlyAccessContinue')).toBeVisible(); await expect(page.locator('#earlyAccessAcceptForm')).toBeHidden();
  expect(auth.writes).toHaveLength(1); const sent = auth.writes[0];
  expect(sent.method).toBe('POST'); expect(sent.bearer).toBe(auth.firstSession.access_token);
  expect(Object.keys(sent.body).sort()).toEqual(['target_correlation_id', 'target_expected_actor_id', 'target_generation_id', 'target_operation_id', 'target_token']);
  expect(sent.body).toMatchObject({ target_expected_actor_id: auth.A, target_generation_id: generationId, target_token: token });
  expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
});
for (const mode of ['unknown', 'wrong-owner', 'rate_limited']) test(`invitation ${mode} keeps exactly one original intent for explicit retry`, async ({ page, context }) => {
  const auth = await fixture(context); await ready(page); auth.mode(mode); await accept(page);
  await expect(page.locator('#earlyAccessAccept')).toHaveText('Retry same acceptance');
  await expect(page.locator('#earlyAccessContinue')).toBeHidden(); expect(auth.writes).toHaveLength(1);
  expect(await page.content()).not.toContain('PRIVATE_TOKEN_RESPONSE');
  const original = structuredClone(auth.writes[0].body); await page.locator('#earlyAccessAccept').click();
  await expect(page.locator('#earlyAccessContinue')).toBeVisible(); expect(auth.writes).toHaveLength(2); expect(auth.writes[1].body).toEqual(original);
});
test('session replacement clears consent and requires a new explicit review before any acceptance', async ({ page, context }) => {
  const auth = await fixture(context); await ready(page); await page.locator('#earlyAccessAcceptAcknowledgement').check();
  await replaceSession(page, auth.session(auth.B));
  await expect(page.locator('#earlyAccessAcceptForm')).toBeHidden(); await expect(page.locator('#earlyAccessReview')).toBeVisible(); expect(auth.writes).toHaveLength(0);
  await page.locator('#earlyAccessReview').click(); await expect(page.locator('#earlyAccessAcceptForm')).toBeVisible();
  await expect(page.locator('#earlyAccessAcceptAcknowledgement')).not.toBeChecked(); await expect(page.locator('#earlyAccessAccept')).toBeDisabled();
  expect(auth.writes).toHaveLength(0);
});
for (const phase of ['get_member_access_context', 'accept_early_access_invitation']) test(`changed owner during ${phase} cannot publish a stale acceptance`, async ({ page, context }) => {
  const auth = await fixture(context); await ready(page); const before = auth.reads.length; const release = auth.holdRpc(phase);
  await accept(page); await expect.poll(() => phase === 'get_member_access_context' ? auth.reads.length : auth.writes.length).toBe(phase === 'get_member_access_context' ? before + 1 : 1);
  await replaceSession(page, auth.session(auth.B)); release();
  await expect(page.locator('#earlyAccessAcceptForm')).toBeHidden(); await expect(page.locator('#earlyAccessContinue')).toBeHidden();
  await expect(page.locator('#earlyAccessReview')).toBeVisible(); expect(auth.writes).toHaveLength(phase === 'get_member_access_context' ? 0 : 1);
});
test('a completed receipt is cleared when the account changes', async ({ page, context }) => {
  const auth = await fixture(context); await ready(page); await accept(page); await expect(page.locator('#earlyAccessContinue')).toBeVisible();
  await replaceSession(page, auth.session(auth.B)); await expect(page.locator('#earlyAccessContinue')).toBeHidden();
  await expect(page.locator('#earlyAccessInviteStatus')).not.toContainText('Early Access accepted'); expect(auth.writes).toHaveLength(1);
});
test('BFCache return rechecks native ownership with no retained consent or automatic write', async ({ page, context }) => {
  const auth = await fixture(context); await ready(page); await page.locator('#earlyAccessAcceptAcknowledgement').check();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('#earlyAccessAcceptForm')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#earlyAccessAcceptForm')).toBeVisible(); await expect(page.locator('#earlyAccessAcceptAcknowledgement')).not.toBeChecked();
  await expect(page.locator('#earlyAccessAccept')).toBeDisabled(); expect(auth.writes).toHaveLength(0);
});
for (const fragment of ['', '#token=invalid', '#access_token=not-an-app-invitation']) test(`missing or malformed capability ${fragment || '(missing)'} never presents acceptance`, async ({ page, context }) => {
  const auth = await fixture(context); await page.goto(`${routePath}${fragment}`);
  await expect(page.locator('#earlyAccessInviteStatus')).toContainText('Open the current invitation');
  await expect(page.locator('#earlyAccessAcceptForm')).toBeHidden(); expect(auth.writes).toHaveLength(0); expect(auth.reads).toHaveLength(0);
  expect(new URL(page.url()).hash).toBe('');
});
test('expired tab continuation cannot restore a former invitation', async ({ page, context }) => {
  const auth = await fixture(context); await page.goto(routePath);
  await page.evaluate(({ storageKey, token, generationId }) => sessionStorage.setItem(storageKey, JSON.stringify({ token, generationId, capturedAt: Date.now() - 900001 })), { storageKey, token, generationId });
  await page.reload(); await expect(page.locator('#earlyAccessInviteStatus')).toContainText('Open the current invitation');
  await expect(page.locator('#earlyAccessAcceptForm')).toBeHidden(); expect(auth.writes).toHaveLength(0);
});
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) test(`invitation consent is accessible and zoom-safe in ${theme}`, async ({ page, context }, testInfo) => {
  await fixture(context); await ready(page); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.locator('#earlyAccessAcceptAcknowledgement').focus(); await expect(page.locator('#earlyAccessAcceptAcknowledgement')).toBeFocused();
  await page.keyboard.press('Space'); await expect(page.locator('#earlyAccessAccept')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `/tmp/77dc-invitation-${testInfo.project.name}-${theme}.png`, fullPage: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
