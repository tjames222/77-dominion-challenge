import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DAILY_STANDARD_ROUTE_LIST } from '../../src/static/daily-standard-routes.mjs';
import { installDailyBootstrapStub } from './support/daily-bootstrap-supabase-stub.mjs';

const unrelated = /\/(?:challenge_entries|check_ins|community_feed_items)$|\/(?:get_daily_standard_draft|bootstrap_daily_standard_time_zone)$/;
async function usable(page) { await expect(page.locator('#actionCompletionToggle')).toBeEnabled();await expect(page.locator('[data-daily-standard-page]')).toHaveAttribute('aria-busy','false'); }
async function replaceSessions(page, sessions) {
  await page.evaluate(async (values) => {
    const channel = new BroadcastChannel('sb-127-auth-token');
    for (const session of values) {
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
      window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(session) }));
      channel.postMessage({ event: 'SIGNED_IN', session });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    channel.close();
  }, sessions);
}
for(const action of DAILY_STANDARD_ROUTE_LIST)for(const clean of [false,true]){
  test(`${action.id} ${clean?'clean':'html'} uses one focused route bootstrap`,async({page,context},testInfo)=>{
    const fixture=await installDailyBootstrapStub(context);
    await page.goto(clean?action.route.slice(1).replace('.html',''):action.route.slice(1));await usable(page);
    expect(fixture.bootstrapRequests()).toHaveLength(1);
    expect(fixture.bootstrapRequests()[0].method).toBe('POST');
    expect(fixture.bootstrapRequests()[0].args).toEqual({target_expected_actor_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',target_time_zone:'UTC',target_entry_date:null});
    expect(fixture.requests.filter(r=>unrelated.test(r.path))).toEqual([]);
    await expect(page.locator('#actionPageDate')).toHaveAttribute('datetime','2026-09-12');
    await expect(page.locator('#actionProgressCount')).toHaveText('0 of 7 complete');
    await testInfo.attach('separate-startup-request-counts',{contentType:'application/json',body:JSON.stringify({
      focusedRoute:fixture.bootstrapRequests().length,auth:fixture.requests.filter(r=>r.path.startsWith('/auth/')).length,
      sharedShellAndTraining:fixture.requests.filter(r=>r.path.startsWith('/rest/')&&!r.path.endsWith('/get_daily_action_bootstrap')).map(r=>r.path),
      note:'This is one route bootstrap, not a one-request whole page. Shared shell/visit/training remain separately counted.',
    },null,2)});
  });
}
test('overlapping focus/visibility refreshes coalesce; retry reloads after a failed RPC',async({page,context})=>{
  const f=await installDailyBootstrapStub(context);await page.goto('/bible-reading.html');await usable(page);
  const release=f.hold();await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));});
  await expect.poll(()=>f.bootstrapRequests().length).toBe(2);await expect(page.locator('#actionCompletionToggle')).toBeDisabled();
  release();await usable(page);expect(f.bootstrapRequests()).toHaveLength(2);
  f.failNext();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#actionLoadRetry')).toBeVisible();await expect(page.locator('#actionCompletionToggle')).toBeDisabled();
  await page.locator('#actionLoadRetry').click();await usable(page);expect(f.bootstrapRequests()).toHaveLength(4);
});
test('a held old-account response cannot populate a newly signed-in account',async({page,context})=>{
  const f=await installDailyBootstrapStub(context,{completed:['bible']});const release=f.hold();
  await page.goto('/bible-reading.html');await expect.poll(()=>f.bootstrapRequests().length).toBe(1);
  await page.evaluate((session)=>{localStorage.setItem('sb-127-auth-token',JSON.stringify(session));window.dispatchEvent(new StorageEvent('storage',{key:'sb-127-auth-token',newValue:JSON.stringify(session)}));},f.sessionFor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222'));
  release();await expect(page.locator('#actionLoadRetry')).toBeVisible();await expect(page.locator('#actionProgressCount')).toHaveText('0 of 7 complete');
  await expect(page.locator('#actionCompletionToggle')).toBeDisabled();
});
for (const replacement of ['A→B→A', 'same actor, new immutable session']) {
  test(`${replacement} rejects held state and rehydrates outside the Auth callback`, async ({ page, context }) => {
    const f = await installDailyBootstrapStub(context, { completed: ['bible'] });
    await page.goto('/bible-reading.html'); await usable(page);
    const release = f.hold(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => f.bootstrapRequests().length).toBe(2);
    f.completed([]);
    const finalSession = replacement === 'A→B→A' ? f.sessionFor()
      : f.sessionFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222');
    await replaceSessions(page, replacement === 'A→B→A'
      ? [f.sessionFor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), finalSession] : [finalSession]);
    release(); await usable(page);
    await expect(page.locator('#actionProgressCount')).toHaveText('0 of 7 complete');
    expect(f.bootstrapRequests().length).toBeGreaterThan(2);
  });
}
test('an enrolled replacement session resolves the MFA gate without deadlocking Auth', async ({ page, context }) => {
  const f = await installDailyBootstrapStub(context); await page.goto('/bible-reading.html'); await usable(page);
  f.enrolled(true);
  await replaceSessions(page, [f.sessionFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222')]);
  await expect(page).toHaveURL(/account-security\.html/);
  expect(f.bootstrapRequests()).toHaveLength(1);
});
for(const status of ['scheduled','not_started'])test(`${status} is a member-accessible locked action`,async({page,context})=>{
  const f=await installDailyBootstrapStub(context,{status});await page.goto('/morning-prayer.html');
  await expect(page.locator('[data-daily-standard-page]')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('#actionCompletionToggle')).toBeDisabled();await expect(page.locator('#actionLoadRetry')).toBeHidden();
  await expect(page.locator('#actionPageStatus')).toContainText(status==='scheduled'?'scheduled':'Start your challenge');
  expect(f.bootstrapRequests()).toHaveLength(1);expect(f.requests.filter(r=>unrelated.test(r.path))).toEqual([]);
});
test('no membership redirects from the focused access decision, without draft or billing preflight',async({page,context})=>{
  const f=await installDailyBootstrapStub(context,{appAccess:false});
  await context.route(/\/billing\.html(?:\?|$)/,route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<h1>Membership fixture</h1>'}):route.continue());
  await page.goto('/evening-prayer.html');await expect(page).toHaveURL(/billing\.html\?intent=subscription/);
  expect(f.bootstrapRequests()).toHaveLength(1);expect(f.requests.filter(r=>r.path==='/rest/v1/entitlements')).toEqual([]);
});
test('enrolled AAL1 never starts a focused private bootstrap',async({page,context})=>{
  const f=await installDailyBootstrapStub(context,{enrolled:true});await page.goto('/workout-one.html');
  await expect(page).toHaveURL(/account-security\.html/);expect(f.bootstrapRequests()).toHaveLength(0);
});
test('completion remains a user-triggered atomic mutation using the returned canonical date',async({page,context})=>{
  const f=await installDailyBootstrapStub(context);await page.goto('/bible-reading.html');await usable(page);
  await page.locator('#actionCompletionToggle').click();await expect(page.locator('#actionProgressCount')).toHaveText('1 of 7 complete');
  // The count is optimistic. Wait for the existing atomic save, not just paint.
  await expect.poll(()=>f.requests.filter(r=>r.path.endsWith('/mutate_daily_standard_draft')).length).toBe(1);
  await usable(page);
  const mutation=f.requests.find(r=>r.path.endsWith('/mutate_daily_standard_draft'));
  expect(mutation.args.target_entry_date).toBe('2026-09-12');expect(mutation.args.target_expected_version).toBe(2);
  expect(f.bootstrapRequests()).toHaveLength(1);expect(f.requests.some(r=>/submit_daily_check_in/.test(r.path))).toBe(false);
});
for(const theme of ['dark','light','dominion-night','dominion-platinum'])test(`${theme} usable action and retry remain accessible`,async({page,context})=>{
  const f=await installDailyBootstrapStub(context,{theme});await page.goto('/intentional-walk.html');await usable(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  f.failNext();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#actionLoadRetry')).toBeVisible();
  const result=await new AxeBuilder({page}).include('[data-daily-standard-page]').analyze();expect(result.violations).toEqual([]);
  await page.locator('#actionLoadRetry').click();await usable(page);
});
test('a restored page revalidates private state and reconnects its Auth observer',async({page,context})=>{
  const f=await installDailyBootstrapStub(context);await page.goto('/bible-reading.html');await usable(page);
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await usable(page);await expect.poll(()=>f.bootstrapRequests().length).toBe(2);
});
test('a stalled bootstrap has a bounded loading state and usable retry',async({page,context})=>{
  const f=await installDailyBootstrapStub(context);const release=f.hold();await page.clock.install();
  await page.goto('/bible-reading.html');await expect.poll(()=>f.bootstrapRequests().length).toBe(1);
  await page.clock.fastForward(20_001);await expect(page.locator('#actionLoadRetry')).toBeVisible();
  release();await page.locator('#actionLoadRetry').click();await usable(page);expect(f.bootstrapRequests()).toHaveLength(2);
});
