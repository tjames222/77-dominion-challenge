import { test, expect } from '@playwright/test';
import { installFeedbackStub } from './support/feedback-supabase-stub.mjs';
import { dailyBootstrapV2Fixture, DAILY_INSTANCE_ID, rewardCatalogV2Fixture } from '../fixtures/daily-action-bootstrap-v2.mjs';
import { SITE_TRAINING_REGISTRY } from '../../src/static/site-training-registry.mjs';
import { createSiteTrainingPageProgress, normalizeSiteTrainingState } from '../../src/static/site-training-state.mjs';

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
  const data = dailyBootstrapV2Fixture({ actorId: auth.A, entryDate: today, timeZone: 'UTC', completed: ['bible'] });
  const activation = data.activation;
  Object.assign(activation, { startDate: start, status: state === 'in_progress' ? 'active' : 'completed', canEditStartDate: false,
    canParticipate: state === 'in_progress', canMutateDailyStandards: state === 'in_progress' });
  Object.assign(activation.currentInstance, { startDate: start, scopeKey: `original77:${start}`, calendarDay: 78,
    submittedCount: state === 'in_progress' ? 76 : 77, status: activation.status,
    provenance: state === 'in_progress' ? 'legacy_bound' : 'legacy_completed' });
  if (state !== 'in_progress') activation.originalRepeat = { ...activation.originalRepeat, available: true, canStart: true, reason: null };
  data.draft.locked = state !== 'in_progress';
  const payload = () => ({ ...structuredClone(data), asOf: new Date().toISOString(),
    draft: { ...structuredClone(data.draft), activation_status: activation.status, activation: structuredClone(activation) } });
  const calls = []; let posted = false; let hold = null; let readHold = null; let readResponses = 0;
  await context.route('**/__admin_fixture__/functions/v1/share-snapshot', route => {
    const body = route.request().postDataJSON(); calls.push({ name: 'share-snapshot', body });
    expect(body).toEqual({ action: 'preview', kind: 'progress', contractVersion: 2, expectedUserId: auth.A });
    expect(route.request().headers().authorization).toBe(`Bearer ${auth.firstSession.access_token}`);
    const instance = activation.currentInstance; const count = instance.submittedCount;
    return json(route, { schemaVersion: 3, kind: 'progress', defaultExpirationDays: 30,
      context: { schemaVersion: 2, actorId: auth.A, instanceId: DAILY_INSTANCE_ID },
      privacy: { includesIdentity: false, includesGroup: false, includesActivityHistory: false },
      payload: { schemaVersion: 3, kind: 'progress', challengeKey: instance.challengeKey,
        title: instance.title, submittedCheckIns: count, targetCheckIns: instance.targetCount },
      presentation: { eyebrow: instance.title, title: `${count} of ${instance.targetCount} Dominion check-ins`,
        description: `${instance.title}: ${count} of ${instance.targetCount} check-ins submitted. Partial check-ins count.`,
        metric: `${count}/${instance.targetCount}`, metricLabel: 'submitted check-ins' } });
  });
  await context.route(/\/__admin_fixture__\/rest\/v1\/(?:profiles|challenge_entries|check_ins|user_game_stats|rpc\/(?:get_challenge_activation_v2|get_daily_action_bootstrap_v2|get_daily_standard_draft_v2|get_challenge_check_ins_v2|get_reward_catalog_v2|submit_daily_check_in_v2|claim_reward_celebrations))(?:\?|$)/, async route => {
    const request = route.request(), name = new URL(request.url()).pathname.split('/').at(-1);
    const body = request.postData() ? request.postDataJSON() : null;
    const actor = tokens.get(request.headers().authorization?.replace(/^Bearer /, ''));
    calls.push({ name, actor, body, bearer: request.headers().authorization });
    if (!actor) return route.fulfill({ status: 401, body: '{}' });
    if (name === 'profiles') return json(route, { user_id: actor, name: 'Synthetic Member', time_zone: 'UTC', challenge_start_date: start });
    if (name === 'challenge_entries') return json(route, [{ ...data.draft }]);
    if (name === 'check_ins') return json(route, posted ? [{ entry_date: today, challenge_day: 78 }] : []);
    if (name === 'user_game_stats') return json(route, { total_points: posted ? 77 : 76, challenge_points: posted ? 77 : 76 });
    if (name === 'get_challenge_activation_v2') {
      const snapshot = structuredClone(activation);
      if (readHold) await readHold;
      return json(route, snapshot);
    }
    if (name === 'get_daily_standard_draft_v2') return json(route, payload().draft);
    if (name === 'get_daily_action_bootstrap_v2') {
      const snapshot = payload(); if (readHold) await readHold; readResponses += 1; return json(route, snapshot);
    }
    if (name === 'get_challenge_check_ins_v2') {
      expect(body.target_expected_instance_id).toBe(DAILY_INSTANCE_ID);
      const count = activation.currentInstance.submittedCount;
      const checkIns = Array.from({ length: count }, (_, index) => {
        const day = index === 76 ? 78 : index + 1;
        return { instanceId: DAILY_INSTANCE_ID, entry_date: new Date(Date.parse(`${start}T00:00:00Z`) + (day - 1) * 86400000).toISOString().slice(0, 10), challenge_day: day };
      });
      return json(route, { schemaVersion: 2, actorId: actor, instanceId: DAILY_INSTANCE_ID, checkIns });
    }
    if (name === 'get_reward_catalog_v2') return json(route, rewardCatalogV2Fixture(activation));
    if (name === 'claim_reward_celebrations') return json(route, { claimedUnlocks: [], claimToken: body.target_claim_token, leaseSeconds: 900 });
    expect(body.target_expected_actor_id).toBe(auth.A);
    expect(body.target_expected_instance_id).toBe(DAILY_INSTANCE_ID);
    expect(body.target_expected_date).toBe(today);
    expect(body.target_status).toBe('partial');
    expect(body.target_completed).toEqual(['bible']);
    expect(posted).toBe(false);
    if (deferCommit && hold) await hold;
    posted = true;
    Object.assign(activation, { status: 'completed', canParticipate: false, canMutateDailyStandards: false, revision: activation.revision + 1 });
    Object.assign(activation.currentInstance, { submittedCount: 77, status: 'completed',
      completionEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', completedAt: `${today}T12:00:00.123456+00:00` });
    activation.originalRepeat = { ...activation.originalRepeat, available: true, canStart: true, reason: null };
    data.draft.submitted = true; data.draft.locked = true;
    if (!deferCommit && hold) await hold;
    return json(route, { schemaVersion: 2, actorId: actor, instanceId: DAILY_INSTANCE_ID,
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', entry_date: today, challenge_day: 78,
      status: 'partial', completed_count: 1, points_awarded: 1, created_at: `${today}T12:00:00.123456+00:00`,
      activation: malformed ? { ...activation, currentInstance: { ...activation.currentInstance, submittedCount: '77' } } : activation });
  });
  return { ...auth, calls, readResponses: () => readResponses, writes: () => calls.filter(call => call.name === 'submit_daily_check_in_v2'),
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
  // The first data render precedes celebration recovery and foreground
  // listener registration. Wait for boot's final reveal before dispatching
  // a synthetic focus event, otherwise the test can race an absent listener.
  await expect(page.locator('.dashboard-hero')).toHaveClass(/is-visible/);
  // On mobile, implicit click scrolling can still move the page between
  // pointer-down and pointer-up while the scorecard reveals. Settle that
  // setup first, without bypassing the normal click or submission assertions.
  const postButton = page.locator('#checkInButton');
  await postButton.evaluate(button => button.scrollIntoView({ behavior: 'instant', block: 'center' }));
  await expect(page.locator('#check-in')).toHaveClass(/is-visible/);
  await expect.poll(() => postButton.evaluate(async button => {
    const geometry = () => {
      const rect = button.getBoundingClientRect();
      return [window.scrollX, window.scrollY, rect.x, rect.y, rect.width, rect.height];
    };
    const before = geometry();
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const after = geometry();
    const moving = document.getAnimations().some(animation => (
      Number.isFinite(animation.effect?.getComputedTiming().iterations)
      && animation.playState !== 'finished'
    ));
    return !moving && before.every((value, index) => value === after[index]);
  }), { timeout: 10000, message: 'Check-in scroll and reveal geometry must settle before clicking' }).toBe(true);
}
async function complete(page) {
  await expect(page.locator('#challengeDay')).toHaveText('77 of 77 check-ins');
  await expect(page.locator('#challengePercent')).toHaveText('100%');
  await expect(page.locator('#challengeCompletePanel')).toBeVisible();
  await expect(page.locator('#checkInButton')).toBeDisabled();
  await expect(page.locator('#checklist .check-row-toggle').first()).toBeDisabled();
  await expect(page.locator('#challengeCompletePanel')).toContainText('Partial check-ins count');
}

// Reuse the real-SDK member fixture above; only transport responses are
// controlled. No app API is invoked manually and no Auth count is assumed.
async function startupFixture(context, { failVisits = false, holdInitialHistory = false } = {}) {
  const auth = await fixture(context);
  const tokens = new Map([[auth.firstSession.access_token, 'original']]);
  const calls = []; let visits = 0;
  await context.route(/\/__admin_fixture__\/rest\/v1\/community_feed_items(?:\?|$)/, route => {
    if (route.request().method() !== 'HEAD') return route.fallback();
    return route.fulfill({ status: 200, headers: { 'Content-Range': '*/0', 'Content-Length': '0' }, body: '' });
  });
  await context.route(/\/__admin_fixture__\/rest\/v1\/rpc\/get_site_training_state$/, route => {
    const body = route.request().postDataJSON();
    const page = SITE_TRAINING_REGISTRY.pages.find(value => value.id === body.target_page_id);
    const program = SITE_TRAINING_REGISTRY.programs.find(value => value.id === body.target_program_id) || null;
    expect(page).toBeTruthy();
    const value = createSiteTrainingPageProgress(page, body.target_expected_actor_id);
    if (program) value.overall = { programId: program.id, programVersion: program.version, status: 'completed',
      currentPageId: program.pages[0].pageId, currentPageContentVersion: program.pages[0].contentVersion,
      currentPageIndex: 0, revision: 1, startedAt: '2026-01-01T00:00:00Z', stoppedAt: null,
      completedAt: '2026-01-01T00:01:00Z', updatedAt: '2026-01-01T00:01:00Z' };
    expect(normalizeSiteTrainingState(value, { expectedPage: page, expectedProgram: program }).contractValid).toBe(true);
    return json(route, value);
  });
  await context.route(/\/__admin_fixture__\/rest\/v1\/(?:user_game_stats|user_badges|rpc\/record_app_visit)(?:\?|$)/, async route => {
    const request = route.request(), name = new URL(request.url()).pathname.split('/').at(-1);
    const generation = tokens.get(request.headers().authorization?.replace(/^Bearer /, ''));
    expect(generation).toBeTruthy();
    const call = { name, generation, visitsAtDispatch: visits }; calls.push(call);
    if (name === 'record_app_visit') {
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({ target_expected_actor_id: auth.A });
      if (failVisits) return route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ message: 'Synthetic unavailable visit transport' }) });
      visits += 1;
      return json(route, [{ current_app_streak: 6, best_app_streak: 8, new_badges: [] }]);
    }
    expect(new URL(request.url()).searchParams.get('user_id')).toBe(`eq.${auth.A}`);
    if (name === 'user_badges') return json(route, []);
    const today = new Date().toISOString().slice(0, 10);
    return json(route, { total_points: 76, challenge_points: 76, current_app_streak: visits ? 6 : 5,
      best_app_streak: 8, last_seen_date: today });
  });
  let enterHistory, releaseHistory, held = false;
  const historyEntered = new Promise(resolve => { enterHistory = resolve; });
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  if (holdInitialHistory) await context.route(/\/__admin_fixture__\/rest\/v1\/rpc\/get_challenge_check_ins_v2$/, async route => {
    if (!held) { held = true; enterHistory(); await historyGate; }
    return route.fallback();
  });
  return { ...auth, calls, historyEntered, releaseHistory,
    replacement() { const session = auth.replacement(); tokens.set(session.access_token, 'replacement'); return session; },
    count(name) { return calls.filter(call => call.name === name).length; } };
}

async function startupReady(page, streak = '6') {
  await expect(page.locator('#challengeDay')).toHaveText('76 of 77 check-ins');
  await expect(page.locator('#checkInButton')).toBeEnabled();
  await expect(page.locator('.shared-header-streak-count')).toHaveText(streak);
  // This reveal follows initial hydration and celebration recovery, so count
  // assertions do not finish at the earlier, partial Dashboard render.
  await expect(page.locator('.dashboard-hero')).toHaveClass(/is-visible/);
}

test('Dashboard startup naturally uses two visits, two stats reads and one badge read', async ({ context, page }) => {
  const auth = await startupFixture(context);
  await page.goto('/dashboard.html'); await startupReady(page);
  expect(auth.count('record_app_visit')).toBe(2);
  expect(auth.count('user_game_stats')).toBe(2);
  expect(auth.count('user_badges')).toBe(1);
  expect(auth.calls.filter(call => call.name === 'user_game_stats').every(call => call.visitsAtDispatch > 0)).toBe(true);
});

test('Dashboard startup reads its own fresh game pair after its visit when the header is settled', async ({ context, page }) => {
  const auth = await startupFixture(context, { holdInitialHistory: true });
  await page.goto('/dashboard.html'); await auth.historyEntered;
  // Deliberately settle the independent header before releasing Dashboard's
  // history response. Counts alone cannot identify which visit came first.
  try {
    await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
    expect(auth.count('record_app_visit')).toBe(1);
    expect(auth.count('user_game_stats')).toBe(1);
    expect(auth.count('user_badges')).toBe(0);
  } finally { auth.releaseHistory(); }
  await startupReady(page);
  expect(auth.count('record_app_visit')).toBe(2);
  expect(auth.count('user_game_stats')).toBe(2);
  expect(auth.count('user_badges')).toBe(1);
  expect(auth.calls.find(call => call.name === 'user_badges').visitsAtDispatch).toBe(2);
  expect(auth.calls.filter(call => call.name === 'user_game_stats').map(call => call.visitsAtDispatch)).toEqual([1, 2]);
});

test('Dashboard startup keeps fresh reads after failed visits without automatic mutation retry', async ({ context, page }) => {
  const warnings = []; page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  const auth = await startupFixture(context, { failVisits: true, holdInitialHistory: true });
  await page.goto('/dashboard.html'); await auth.historyEntered;
  // The held Dashboard cannot yet visit. This first failed attempt and fresh
  // stats response therefore belong to the independently settled header.
  try {
    await expect(page.locator('.shared-header-streak-count')).toHaveText('5');
    expect(auth.count('record_app_visit')).toBe(1);
    expect(auth.count('user_game_stats')).toBe(1);
    expect(auth.count('user_badges')).toBe(0);
  } finally { auth.releaseHistory(); }
  await startupReady(page, '5');
  expect(auth.count('record_app_visit')).toBe(2);
  expect(auth.count('user_game_stats')).toBe(2);
  expect(auth.count('user_badges')).toBe(1);
  expect(auth.calls.filter(call => call.name === 'user_game_stats').every(call => call.visitsAtDispatch === 0)).toBe(true);
  expect(auth.calls.findLastIndex(call => call.name === 'record_app_visit'))
    .toBeLessThan(auth.calls.findIndex(call => call.name === 'user_badges'));
  expect(warnings.some(value => value.includes('Unable to record daily app visit'))).toBe(true);
  expect(auth.writes()).toHaveLength(0);
});

test('Dashboard startup cannot dispatch its stale visit after a same-user session replacement', async ({ context, page }) => {
  const auth = await startupFixture(context, { holdInitialHistory: true });
  await page.goto('/dashboard.html'); await auth.historyEntered;
  await expect(page.locator('.shared-header-streak-count')).toHaveText('6');
  expect(auth.count('record_app_visit')).toBe(1); // The independent header only.
  const session = auth.replacement();
  const freshRead = page.waitForResponse(response => response.url().endsWith('/get_member_access_context')
    && response.request().headers().authorization === `Bearer ${session.access_token}`);
  try {
    await page.evaluate(value => {
      localStorage.setItem('sb-127-auth-token', JSON.stringify(value));
      const channel = new BroadcastChannel('sb-127-auth-token');
      channel.postMessage({ event: 'SIGNED_IN', session: value }); channel.close();
    }, session);
    await (await freshRead).finished();
  } finally { auth.releaseHistory(); }
  await startupReady(page);
  expect(auth.calls.filter(call => call.name === 'record_app_visit')).toEqual([
    { name: 'record_app_visit', generation: 'original', visitsAtDispatch: 0 },
  ]);
  expect(auth.calls.filter(call => call.name === 'user_badges').map(call => call.generation)).toEqual(['replacement']);
  expect(auth.writes()).toHaveLength(0);
});

test('partial 77th submission on calendar day 78 completes once and remains complete on reload', async ({ context, page }, testInfo) => {
  const auth = await fixture(context); await ready(page);
  const release = auth.hold(); await page.locator('#checkInButton').click();
  await expect.poll(() => auth.writes().length).toBe(1);
  await expect(page.locator('#checkInButton')).toBeDisabled();
  await page.locator('#checkInButton').dispatchEvent('click');
  release(); await complete(page);
  await expect(page.locator('#checkInStatus')).toContainText('Your final check-in is posted');
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
test('historical completion preserves the completed run without an invented canonical Finisher', async ({ context, page }, testInfo) => {
  const auth = await fixture(context, { state: 'historical_provenance_pending' });
  await page.goto('/dashboard.html');
  await expect(page.locator('#challengeDay')).toHaveText('Completed · history preserved');
  await expect(page.locator('#challengeCompletePanel')).toBeVisible();
  await expect(page.locator('#dashboardLead')).toContainText('Your history and rewards are preserved');
  await expect(page.locator('#checkInButton')).toBeDisabled();
  await expect(page.locator('#badgeCelebration')).toBeHidden();
  await page.locator('#challengeCompletePanel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('original77-historical-preserved.png'), fullPage: true });
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
  const previousReads = auth.calls.filter(call => call.name === 'get_daily_action_bootstrap_v2').length;
  const release = auth.holdRead();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => auth.calls.filter(call => call.name === 'get_daily_action_bootstrap_v2').length).toBeGreaterThan(previousReads);
  await page.locator('#checkInButton').click(); await complete(page);
  const beforeRelease = auth.readResponses(); release();
  await expect.poll(() => auth.readResponses()).toBeGreaterThan(beforeRelease);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await complete(page);
  expect(auth.writes()).toHaveLength(1);
});

test('a delayed successful response cannot restore a page hidden during the write', async ({ context, page }) => {
  const auth = await fixture(context); await ready(page);
  const release = auth.hold(); await page.locator('#checkInButton').click();
  await expect.poll(() => auth.writes().length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  const response = page.waitForResponse(value => value.url().endsWith('/submit_daily_check_in_v2'));
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
  const freshRead = page.waitForResponse(response => response.url().endsWith('/get_challenge_activation_v2')
    && response.request().headers().authorization === `Bearer ${session.access_token}`);
  await page.evaluate(value => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(value));
    const channel = new BroadcastChannel('sb-127-auth-token');
    channel.postMessage({ event: 'SIGNED_IN', session: value }); channel.close();
  }, session);
  await (await freshRead).finished();
  await expect(page.locator('#challengeDay')).toHaveText('76 of 77 check-ins');
  const newSessionReads = () => auth.calls.filter(call => call.name === 'get_daily_action_bootstrap_v2'
    && call.bearer === `Bearer ${session.access_token}`).length;
  const beforeRecovery = newSessionReads();
  const releaseRecovery = auth.holdRead();
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/submit_daily_check_in_v2'));
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
