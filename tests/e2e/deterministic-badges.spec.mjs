import { test, expect } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import { deliveryRowsFor } from './support/preview-badge-browser-support.mjs';

async function badgeState(page) {
  return page.evaluate(()=>{
    const owner=localStorage.getItem('dominion:mockUserId');
    return JSON.parse(localStorage.getItem('dominion:challengeAggregateV2:'+owner))?.values['dominion:badgeState:v1'];
  });
}
async function postBadgeCheckIn(page, completed) {
  return page.evaluate(async completed=>{
    const api=await import('/src/static/api.js');const user=await api.getLocalOrSessionUser();
    const expectedUserId=user.userId;
    const bootstrap=await api.getDailyActionBootstrap({expectedUserId,timeZone:'UTC'});
    const expectedInstanceId=bootstrap.instanceId;
    let draft=bootstrap.draft;
    for(const actionId of completed) draft=await api.mutateDailyStandardDraft({
      date:bootstrap.entryDate,actionId,completed:true,expectedVersion:draft.version,expectedUserId,expectedInstanceId,
    });
    if(completed.includes('workoutTwo')) await api.setDailyStandardWorkoutDifficulty({
      date:bootstrap.entryDate,workoutId:'two',difficulty:'hard',expectedVersion:draft.version,expectedUserId,expectedInstanceId,
    });
    return api.recordPreviewCheckInBadges({date:bootstrap.entryDate,timeZone:'UTC',completed}, {expectedUserId,expectedInstanceId});
  },completed);
}
test('posted partial workout atomically earns foundations without a guessed Medium badge',async({page,app})=>{
  await app.open(ROUTE_BY_ID.dashboard,{state:'memberRewardsAcknowledged'});
  const result=await postBadgeCheckIn(page,['workoutTwo']);
  expect(result.map(r=>r.key)).toContain('honest_partial');
  expect(result.map(r=>r.key)).toContain('hard_path');
  expect(result.map(r=>r.key)).not.toContain('steady_grind');
  expect(result.map(r=>r.key)).not.toContain('two_week_guard');
  expect(result.map(r=>r.key)).not.toContain('check_ins_14');
});
test('Dashboard consumes durable awards in catalog order and acknowledges only presented badges',async({page,app})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await app.open(ROUTE_BY_ID.dashboard,{state:'memberRewardsAcknowledged'});
  await page.locator('#selectAllActionsButton').click();
  await page.locator('#checkInButton').click();
  await expect(page.locator('#rewardToast')).toBeVisible();
  const state=await badgeState(page);
  const earned=state.awards.filter(r=>r.legacy===false);
  const owner=await page.evaluate(()=>localStorage.getItem('dominion:mockUserId'));
  expect(earned.map(r=>r.key)).toEqual(['iron_standard']);
  expect(earned[0].celebrationSeenAt).toBeNull();
  const beforePresentation=(await deliveryRowsFor(page,owner,'badge')).find(r=>r.itemId===earned[0].awardId);
  expect(!beforePresentation||beforePresentation.seenAt===null,'the canonical award is not acknowledged before presentation').toBe(true);
  await page.locator('#rewardToast [data-dismiss-celebration]').click();
  await expect(page.locator('#badgeCelebration')).toBeVisible();
  await expect(page.locator('#badgeCelebrationTitle')).toHaveText('Seven for Seven');
  await expect(page.locator('#badgeCelebrationCopy')).toHaveText('You posted 7 of the seven Daily Actions.');
  await page.keyboard.press('Escape');
  await expect.poll(async()=>Boolean((await deliveryRowsFor(page,owner,'badge')).find(r=>r.itemId===earned[0].awardId)?.seenAt)).toBe(true);
  await page.reload();
  await expect(page.locator('#badgeCelebration')).toBeHidden();
});
test('two tabs cannot claim the same unseen badge batch and an account switch cannot acknowledge it',async({page,context,app})=>{
  await app.open(ROUTE_BY_ID.dashboard,{state:'memberRewardsAcknowledged'});
  await postBadgeCheckIn(page,['walk']);
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
  await app.open(ROUTE_BY_ID.dashboard,{state:'memberRewardsAcknowledged'});
  const result=await page.evaluate(async()=>{
    const api=await import('/src/static/api.js');
    const owner=(await api.getLocalOrSessionUser()).userId;
    const key='dominion:challengeAggregateV2:'+owner;const aggregate=JSON.parse(localStorage.getItem(key));
    const state=aggregate.values['dominion:badgeState:v1'];
    state.awards.push(...['lifetime','original77:2026-01-01'].map((scopeKey,index)=>({key:'seven_sealed',scopeKey,awardId:`scope-${index}`,name:'7-Day Perfect Streak',earnedAt:'2026-01-07T12:00:00Z',legacy:true})));
    aggregate.values['dominion:badges']=state.awards;
    aggregate.generation+=1;localStorage.setItem(key,JSON.stringify(aggregate));
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
