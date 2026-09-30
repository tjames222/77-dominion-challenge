import { test, expect } from '@playwright/test';
import { installFeedbackStub } from './support/feedback-supabase-stub.mjs';
import { dailyBootstrapFixture } from '../fixtures/daily-action-bootstrap.mjs';

// Compiled production-mode client with the real SDK and synthetic local HTTP.
// SQL authority, concurrent writes, and durable award delivery have separate
// native database fixtures; this suite proves the browser contract and UX.
const json = (route, value) => route.fulfill({ contentType: 'application/json',
  headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(value) });
async function fixture(context, { state = 'in_progress', malformed = false, deferCommit = false } = {}) {
  const auth = await installFeedbackStub(context, { active: false, memberPages: true });
  const tokens = new Map([[auth.firstSession.access_token, auth.A]]);
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - 77 * 86400000).toISOString().slice(0, 10);
  const data = dailyBootstrapFixture({ actorId: auth.A, entryDate: today, timeZone: 'UTC', completed: ['bible'] });
  const activation = data.activation;
  Object.assign(activation, { startDate: start, challengeDay: 78, canEditStartDate: false,
    canParticipate: state === 'in_progress', canMutateDailyStandards: state === 'in_progress' });
  Object.assign(activation.originalProgress, { instanceId: `original77:${start}`,
    submittedCount: state === 'in_progress' ? 76 : 77, completionState: state });
  data.draft.locked = state !== 'in_progress';
  const calls = []; let posted = false; let hold = null; let readHold = null;
  await context.route('**/__admin_fixture__/functions/v1/share-snapshot', route => {
    const body = route.request().postDataJSON(); calls.push({ name: 'share-snapshot', body });
    expect(body).toEqual({ action: 'preview', kind: 'progress' });
    expect(route.request().headers().authorization).toBe(`Bearer ${auth.firstSession.access_token}`);
    const count = activation.originalProgress.submittedCount;
    return json(route, { schemaVersion: 2, kind: 'progress',
      payload: { schemaVersion: 2, kind: 'progress', submittedCheckIns: count, targetCheckIns: 77 },
      presentation: { title: `${count} of 77 Dominion check-ins`, metric: `${count}/77`, metricLabel: 'submitted check-ins' } });
  });
  await context.route(/\/__admin_fixture__\/rest\/v1\/(?:profiles|challenge_entries|check_ins|user_game_stats|rpc\/(?:get_challenge_activation|get_daily_action_bootstrap|get_daily_standard_draft|submit_daily_check_in|claim_reward_celebrations))(?:\?|$)/, async route => {
    const request = route.request(), name = new URL(request.url()).pathname.split('/').at(-1);
    const body = request.postData() ? request.postDataJSON() : null;
    const actor = tokens.get(request.headers().authorization?.replace(/^Bearer /, ''));
    calls.push({ name, actor, body, bearer: request.headers().authorization });
    if (!actor) return route.fulfill({ status: 401, body: '{}' });
    if (name === 'profiles') return json(route, { user_id: actor, name: 'Synthetic Member', time_zone: 'UTC', challenge_start_date: start });
    if (name === 'challenge_entries') return json(route, [{ ...data.draft }]);
    if (name === 'check_ins') return json(route, posted ? [{ entry_date: today, challenge_day: 78 }] : []);
    if (name === 'user_game_stats') return json(route, { total_points: posted ? 77 : 76, challenge_points: posted ? 77 : 76 });
    if (name === 'get_challenge_activation') {
      const snapshot = structuredClone(activation);
      if (readHold) await readHold;
      return json(route, snapshot);
    }
    if (name === 'get_daily_standard_draft') return json(route, data.draft);
    if (name === 'get_daily_action_bootstrap') return json(route, { ...data, asOf: new Date().toISOString() });
    if (name === 'claim_reward_celebrations') return json(route, { claimedUnlocks: [], claimToken: body.target_claim_token, leaseSeconds: 900 });
    expect(body.target_expected_actor_id).toBe(auth.A);
    expect(body.target_expected_date).toBe(today);
    expect(body.target_status).toBe('partial');
    expect(body.target_completed).toEqual(['bible']);
    expect(posted).toBe(false);
    if (deferCommit && hold) await hold;
    posted = true;
    Object.assign(activation, { canParticipate: false, canMutateDailyStandards: false });
    Object.assign(activation.originalProgress, { submittedCount: 77, completionState: 'live_completed', canonicalEvent: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      localDate: today, recordedAt: `${today}T12:00:00.123456+00:00`, persistedAt: `${today}T12:00:00.123455+00:00`,
    } });
    data.draft.submitted = true; data.draft.locked = true;
    if (!deferCommit && hold) await hold;
    return json(route, { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', entry_date: today, challenge_day: 78,
      status: 'partial', completed_count: 1, points_awarded: 1, created_at: `${today}T12:00:00.123456+00:00`,
      activation: malformed ? { ...activation, originalProgress: { ...activation.originalProgress, submittedCount: '77' } } : activation });
  });
  return { ...auth, calls, writes: () => calls.filter(call => call.name === 'submit_daily_check_in'),
    replacement() { const value = auth.replacement(auth.A); tokens.set(value.access_token, auth.A); return value; },
    holdRead() { let release; readHold = new Promise(resolve => { release = resolve; }); return () => { release(); readHold = null; }; },
    hold() { let release; hold = new Promise(resolve => { release = resolve; }); return () => { release(); hold = null; }; } };
}
test.beforeEach(async ({ context, page, baseURL }) => {
  const external = [], errors = [], dialogs = [];
  page.on('request', request => { if (new URL(request.url()).origin !== baseURL) external.push(request.url()); });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== baseURL) { external.push(route.request().url()); return route.abort(); }
    return route.fallback();
  });
  await context.routeWebSocket(/.*/, socket => { external.push('websocket'); socket.close(); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  page.__checks = { external, errors, dialogs };
});
test.afterEach(async ({ page }) => {
  expect(page.__checks.external).toEqual([]); expect(page.__checks.errors).toEqual([]); expect(page.__checks.dialogs).toEqual([]);
});
async function ready(page) {
  await page.goto('/dashboard.html');
  await expect(page.locator('#challengeDay')).toHaveText('76 of 77 check-ins');
  await expect(page.locator('#scorecardCalendarDay')).toContainText('Calendar day 78');
  await expect(page.locator('#checkInButton')).toBeEnabled();
}
async function complete(page) {
  await expect(page.locator('#challengeDay')).toHaveText('77 of 77 check-ins');
  await expect(page.locator('#challengePercent')).toHaveText('100%');
  await expect(page.locator('#challengeCompletePanel')).toBeVisible();
  await expect(page.locator('#checkInButton')).toBeDisabled();
  await expect(page.locator('#checklist .check-row-toggle').first()).toBeDisabled();
  await expect(page.locator('#challengeCompletePanel')).toContainText('Partial check-ins count');
}
test('partial 77th submission on calendar day 78 completes once and remains complete on reload', async ({ context, page }, testInfo) => {
  const auth = await fixture(context); await ready(page);
  const release = auth.hold(); await page.locator('#checkInButton').click();
  await expect.poll(() => auth.writes().length).toBe(1);
  await expect(page.locator('#checkInButton')).toBeDisabled();
  await page.locator('#checkInButton').dispatchEvent('click');
  release(); await complete(page);
  await expect(page.locator('#checkInStatus')).toContainText('Your 77th check-in is posted');
  await expect(page.locator('#rewardToast')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#rewardToast')).toBeHidden();
  await page.locator('#challengeCompletePanel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('original77-completed.png'), fullPage: true });
  await page.reload(); await complete(page); expect(auth.writes()).toHaveLength(1);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('.share-preview-metric')).toHaveText('77/77');
  await expect(page.locator('.share-preview-metric-label')).toHaveText('submitted check-ins');
  expect(auth.calls.filter(call => call.name === 'share-snapshot')).toHaveLength(1);
});
test('historical 77 submissions display pending verification without an invented Finisher', async ({ context, page }, testInfo) => {
  const auth = await fixture(context, { state: 'historical_provenance_pending' });
  await page.goto('/dashboard.html');
  await expect(page.locator('#challengeDay')).toHaveText('77 of 77 check-ins');
  await expect(page.locator('#countdownCallout')).toContainText('Historical Finisher verification is pending');
  await expect(page.locator('#challengeCompletePanel')).toBeHidden();
  await expect(page.locator('#checkInButton')).toBeDisabled();
  await page.locator('#countdownCard').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('original77-historical-pending.png'), fullPage: true });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('.share-preview-metric')).toHaveText('77/77');
  expect(auth.writes()).toHaveLength(0);
});
test('committed submission with malformed progress refreshes without a failed-post alert or duplicate', async ({ context, page }) => {
  const auth = await fixture(context, { malformed: true }); await ready(page);
  await page.locator('#checkInButton').click(); await complete(page);
  await expect(page.locator('#checkInStatus')).toContainText('check-in is posted');
  await page.locator('#checkInButton').dispatchEvent('click'); expect(auth.writes()).toHaveLength(1);
});

test('an older in-flight dashboard read cannot reopen participation after the committed 77th response', async ({ context, page }) => {
  const auth = await fixture(context); await ready(page);
  const previousReads = auth.calls.filter(call => call.name === 'get_challenge_activation').length;
  const release = auth.holdRead();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => auth.calls.filter(call => call.name === 'get_challenge_activation').length).toBeGreaterThan(previousReads);
  await page.locator('#checkInButton').click(); await complete(page);
  const response = page.waitForResponse(value => value.url().endsWith('/get_challenge_activation'));
  release(); await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await complete(page);
  expect(auth.writes()).toHaveLength(1);
});

test('a delayed successful response cannot restore a page hidden during the write', async ({ context, page }) => {
  const auth = await fixture(context); await ready(page);
  const release = auth.hold(); await page.locator('#checkInButton').click();
  await expect.poll(() => auth.writes().length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  const response = page.waitForResponse(value => value.url().endsWith('/submit_daily_check_in'));
  release(); await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#challengeCompletePanel')).toBeHidden();
  await expect(page.locator('#checkInButton')).toBeDisabled();
  await expect(page.locator('#challengeDay')).not.toHaveText('77 of 77 check-ins');
  expect(auth.writes()).toHaveLength(1);
});

test('a same-user replacement session cannot consume the previous session’s delayed success', async ({ context, page }) => {
  const auth = await fixture(context, { deferCommit: true }); await ready(page);
  const release = auth.hold(); await page.locator('#checkInButton').click();
  await expect.poll(() => auth.writes().length).toBe(1);
  const session = auth.replacement();
  const freshRead = page.waitForResponse(response => response.url().endsWith('/get_challenge_activation')
    && response.request().headers().authorization === `Bearer ${session.access_token}`);
  await page.evaluate(value => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(value));
    const channel = new BroadcastChannel('sb-127-auth-token');
    channel.postMessage({ event: 'SIGNED_IN', session: value }); channel.close();
  }, session);
  await (await freshRead).finished();
  await expect(page.locator('#challengeDay')).toHaveText('76 of 77 check-ins');
  const newSessionReads = () => auth.calls.filter(call => call.name === 'get_challenge_activation'
    && call.bearer === `Bearer ${session.access_token}`).length;
  const beforeRecovery = newSessionReads();
  const releaseRecovery = auth.holdRead();
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/submit_daily_check_in'));
  release(); await (await oldResponse).finished();
  // A committed old-session response may cause a fresh current-session read,
  // but it cannot itself supply completion state. Hold that recovery read to
  // distinguish authoritative refresh from accepting the previous response.
  await expect.poll(newSessionReads).toBeGreaterThan(beforeRecovery);
  await expect(page.locator('#challengeDay')).toHaveText('76 of 77 check-ins');
  await expect(page.locator('#challengeCompletePanel')).toBeHidden();
  await expect(page.locator('#checkInButton')).toBeDisabled();
  await expect(page.locator('#checkInStatus')).not.toContainText('77th');
  releaseRecovery(); await complete(page); expect(auth.writes()).toHaveLength(1);
});
