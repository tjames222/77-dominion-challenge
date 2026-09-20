import { test, expect } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

async function badgeState(page) {
  return page.evaluate(async()=>{
    const {readPreviewUserValue}=await import('/src/static/preview-user-state.mjs');
    return readPreviewUserValue(localStorage,localStorage.getItem('dominion:mockUserId'),'dominion:badgeState:v1',null);
  });
}
test('posted partial workout atomically earns foundations without a guessed Medium badge',async({page,app})=>{
  await app.open(ROUTE_BY_ID.dashboard);
  const result=await page.evaluate(async()=>{
    const api=await import('/src/static/api.js');const user=await api.getLocalOrSessionUser();
    return api.recordPreviewCheckInBadges({date:'2026-02-14',day:14,completed:['workoutTwo'],workoutDifficultySelections:{two:'hard'}},{expectedUserId:user.userId});
  });
  expect(result.map(r=>r.key)).toContain('honest_partial');
  expect(result.map(r=>r.key)).toContain('hard_path');
  expect(result.map(r=>r.key)).not.toContain('steady_grind');
  expect(result.map(r=>r.key)).not.toContain('two_week_guard');
  expect(result.map(r=>r.key)).not.toContain('check_ins_14');
});
test('Dashboard consumes durable awards in catalog order and acknowledges only presented badges',async({page,app})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await app.open(ROUTE_BY_ID.dashboard);
  await page.locator('#selectAllActionsButton').click();
  await page.locator('#checkInButton').click();
  await expect(page.locator('#rewardToast')).toBeVisible();
  const state=await badgeState(page);
  const earned=state.awards.filter(r=>r.legacy===false);
  expect(earned.map(r=>r.key)).toEqual(['iron_standard']);
  expect(earned[0].celebrationSeenAt).toBeNull();
  await page.locator('#rewardToast [data-dismiss-celebration]').click();
  await expect(page.locator('#badgeCelebration')).toBeVisible();
  await expect(page.locator('#badgeCelebrationTitle')).toHaveText('Seven for Seven');
  await expect(page.locator('#badgeCelebrationCopy')).toHaveText('You posted 7 of the seven Daily Actions.');
  await page.keyboard.press('Escape');
  await expect.poll(async()=>Boolean((await badgeState(page)).awards.find(r=>r.key==='iron_standard').celebrationSeenAt)).toBe(true);
  await page.reload();
  await expect(page.locator('#badgeCelebration')).toBeHidden();
});
test('two tabs cannot claim the same unseen badge batch and an account switch cannot acknowledge it',async({page,context,app})=>{
  await app.open(ROUTE_BY_ID.dashboard);
  await page.evaluate(async()=>{const api=await import('/src/static/api.js');const user=await api.getLocalOrSessionUser();await api.recordPreviewCheckInBadges({date:'2026-02-14',day:14,completed:['walk']},{expectedUserId:user.userId});});
  const other=await context.newPage();
  await other.addInitScript(()=>{Date.now=()=>Date.parse('2026-02-14T17:30:00.000Z');});
  await other.goto('/index.html');
  const claimIn=(tab,token)=>tab.evaluate(async(token)=>{const api=await import('/src/static/api.js');const u=await api.getLocalOrSessionUser();return api.claimBadgeCelebrations({expectedUserId:u.userId,claimToken:token});},token);
  const results=await Promise.all([claimIn(page,'one'),claimIn(other,'two')]);
  expect(results.flatMap(r=>r.badges)).toHaveLength(1);
  const owner=await page.evaluate(()=>localStorage.getItem('dominion:mockUserId'));
  const rejected=await other.evaluate(async({owner,result})=>{const api=await import('/src/static/api.js');api.saveLocalMockUser({name:'Other',email:'other@example.test'});try{await api.acknowledgeBadgeCelebrations({expectedUserId:owner,claimToken:result.claimToken,awardIds:result.badges.map(b=>b.awardId)});return false;}catch{return true;}},{owner,result:results.find(r=>r.badges.length)});
  expect(rejected).toBe(true);await other.close();
});
test('API collection preserves scoped identities and rejects an account switch between its reads',async({page,app})=>{
  await app.open(ROUTE_BY_ID.dashboard);
  const result=await page.evaluate(async()=>{
    const api=await import('/src/static/api.js');
    const {readPreviewUserValue,writePreviewUserValue}=await import('/src/static/preview-user-state.mjs');
    const owner=(await api.getLocalOrSessionUser()).userId;
    const key='dominion:badgeState:v1';const state=readPreviewUserValue(localStorage,owner,key,null);
    state.awards.push(...['lifetime','original77:2026-01-01'].map((scopeKey,index)=>({key:'seven_sealed',scopeKey,awardId:`scope-${index}`,name:'7-Day Perfect Streak',earnedAt:'2026-01-07T12:00:00Z',legacy:true})));
    writePreviewUserValue(localStorage,owner,key,state);
    const collection=await api.getBadgeCollection({expectedUserId:owner});
    const ids=collection.earnedBadges.filter(r=>r.key==='seven_sealed').map(r=>r.awardId);
    const pending=api.getBadgeCollection();
    queueMicrotask(()=>api.saveLocalMockUser({name:'Changed',email:'changed@example.test'}));
    let rejected=false;try{await pending;}catch{rejected=true;}
    return {ids,rejected};
  });
  expect(result.ids).toEqual(['scope-0','scope-1']);
  expect(result.rejected).toBe(true);
});
