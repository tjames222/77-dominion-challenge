import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const dashboard = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const instanceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const sourceBetween = (start, end) => {
  const from = dashboard.indexOf(start);
  const to = dashboard.indexOf(end, from);
  assert.notEqual(from, -1, `missing source boundary: ${start}`);
  assert.notEqual(to, -1, `missing source boundary: ${end}`);
  return dashboard.slice(from, to);
};

const mutationFenceSource = sourceBetween(
  'const runCurrentDraftMutation',
  'async function reconcileDailyStandardDraft',
);
const invalidationSource = sourceBetween(
  'function invalidateDashboardOwner',
  'async function hydrateDashboardFromApi',
);
const ownerChangeSource = sourceBetween(
  'async function handleDashboardAuthOwnerChange',
  'function handleDashboardAuthStateChange',
);
const authStateSource = sourceBetween(
  'function handleDashboardAuthStateChange',
  'async function refreshGameSummary',
);

function sessionFixture() {
  const runtime = runInNewContext(`
    let observedAuthOwner = ${JSON.stringify(actorId)};
    let hydratedAuthOwner = ${JSON.stringify(actorId)};
    let authOwnerEpoch = 7;
    let observedAuthSession = null;
    let dashboardHydrationRequestId = 3;
    let entrySaveQueue = Promise.resolve();
    let committedCheckInRefreshPending = 0;
    let challengeActivation = { currentInstance: { id: ${JSON.stringify(instanceId)} } };
    const pendingActionMutations = new Map([['walk', true]]);
    const pendingWorkoutMutations = new Map([['one', 'hard']]);
    const billingWaiters = [];
    let hydrationHold = null;
    const hydrations = [];
    const recoveries = [];
    let clearCount = 0;
    let renderCount = 0;
    let closeCount = 0;
    let redirects = 0;
    const challengeStartFlow = { closeForOwnerChange() { closeCount += 1; } };
    const window = { location: { href: '' } };
    const console = { warn() {} };
    const createChallengeActivationState = () => ({ readState: 'error' });
    const redirectToLogin = () => { redirects += 1; };
    const render = () => { renderCount += 1; };
    const clearDashboardUserState = () => {
      clearCount += 1;
      pendingActionMutations.clear();
      pendingWorkoutMutations.clear();
      entrySaveQueue = Promise.resolve();
    };
    const getBillingState = () => new Promise((resolve, reject) => billingWaiters.push({ resolve, reject }));
    const hydrateDashboardFromApi = async (owner) => {
      hydrations.push({ owner, epoch: authOwnerEpoch });
      if (hydrationHold) await hydrationHold.promise;
    };
    const recoverPendingCelebrations = async () => { recoveries.push(authOwnerEpoch); };
    const isCurrentMutationOwner = (owner) => Boolean(owner
      && owner.userId === observedAuthOwner
      && owner.userId === hydratedAuthOwner
      && owner.epoch === authOwnerEpoch
      && owner.instanceId === challengeActivation.currentInstance.id);

    ${mutationFenceSource}
    ${invalidationSource}
    ${ownerChangeSource}
    ${authStateSource}

    globalThis.fixture = {
      notify: handleDashboardAuthStateChange,
      runMutation: runCurrentDraftMutation,
      recoverCommitted: refreshCommittedCheckInForCurrentOwner,
      captureOwner: () => ({ userId: hydratedAuthOwner, epoch: authOwnerEpoch, instanceId: challengeActivation.currentInstance.id }),
      restoreHydratedOwner: () => { hydratedAuthOwner = observedAuthOwner; },
      holdHydration: () => {
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        hydrationHold = { promise, release };
        return () => { hydrationHold.release(); hydrationHold = null; };
      },
      releaseBilling: (index, value = { authenticated: true, appAccess: true }) => billingWaiters[index].resolve(value),
      state: () => ({ observedAuthOwner, hydratedAuthOwner, authOwnerEpoch, observedAuthSession,
        pendingActions: pendingActionMutations.size, pendingWorkouts: pendingWorkoutMutations.size,
        committedCheckInRefreshPending,
        clearCount, renderCount, closeCount, redirects, billingCount: billingWaiters.length,
        hydrations: [...hydrations], recoveries: [...recoveries] }),
    };
  `, { Promise });
  return runtime;
}

test('a notified same-user session replacement advances the Dashboard epoch and cancels queued draft dispatch', async () => {
  const fixture = sessionFixture();

  await fixture.notify({ event: 'INITIAL_SESSION', user: { userId: actorId }, sessionIdentity: `${actorId}:session-one` });
  const capturedOwner = fixture.captureOwner();
  assert.equal(fixture.state().authOwnerEpoch, 7, 'the first identity observation is not a replacement');

  const replacement = fixture.notify({ event: 'SIGNED_IN', user: { userId: actorId }, sessionIdentity: `${actorId}:session-two` });
  const invalidated = fixture.state();
  assert.equal(invalidated.authOwnerEpoch, 8);
  assert.equal(invalidated.hydratedAuthOwner, '');
  assert.equal(invalidated.pendingActions, 0);
  assert.equal(invalidated.pendingWorkouts, 0);
  assert.equal(invalidated.clearCount, 1);
  assert.equal(invalidated.closeCount, 1);

  let dispatched = 0;
  assert.equal(fixture.runMutation(capturedOwner, () => { dispatched += 1; }), null);
  assert.equal(dispatched, 0, 'an old optimistic queue cannot dispatch in the replacement session');

  fixture.releaseBilling(0);
  await replacement;
  assert.equal(fixture.state().hydrations.length, 1);
  assert.equal(fixture.state().hydrations[0].owner, actorId);
  assert.equal(fixture.state().hydrations[0].epoch, 8);
});

test('a second replacement fences the first replacement handler before it can hydrate or recover private state', async () => {
  const fixture = sessionFixture();
  await fixture.notify({ event: 'INITIAL_SESSION', user: { userId: actorId }, sessionIdentity: `${actorId}:session-one` });

  const stale = fixture.notify({ event: 'SIGNED_IN', user: { userId: actorId }, sessionIdentity: `${actorId}:session-two` });
  const current = fixture.notify({ event: 'SIGNED_IN', user: { userId: actorId }, sessionIdentity: `${actorId}:session-three` });
  assert.equal(fixture.state().billingCount, 2);

  fixture.releaseBilling(0);
  await stale;
  assert.equal(fixture.state().hydrations.length, 0);
  assert.equal(fixture.state().recoveries.length, 0);

  fixture.releaseBilling(1);
  await current;
  assert.equal(fixture.state().hydrations.length, 1);
  assert.equal(fixture.state().hydrations[0].owner, actorId);
  assert.equal(fixture.state().hydrations[0].epoch, 9);
  assert.equal(fixture.state().recoveries.length, 1);
  assert.equal(fixture.state().recoveries[0], 9);
});

test('a first non-initial same-user notification fails closed as a replacement without reloading on INITIAL_SESSION', async () => {
  const initial = sessionFixture();
  await initial.notify({ event: 'INITIAL_SESSION', user: { userId: actorId }, sessionIdentity: `${actorId}:session-one` });
  assert.equal(initial.state().authOwnerEpoch, 7);
  assert.equal(initial.state().billingCount, 0);

  const replacement = sessionFixture();
  const pending = replacement.notify({ event: 'SIGNED_IN', user: { userId: actorId }, sessionIdentity: `${actorId}:session-two` });
  assert.equal(replacement.state().authOwnerEpoch, 8);
  assert.equal(replacement.state().pendingActions, 0);
  assert.equal(replacement.state().billingCount, 1);
  replacement.releaseBilling(0);
  await pending;
});

test('a stale same-actor committed write forces a current-session read even while replacement hydration is pending', async () => {
  const fixture = sessionFixture();
  await fixture.notify({ event: 'INITIAL_SESSION', user: { userId: actorId }, sessionIdentity: `${actorId}:session-one` });
  const staleOwner = fixture.captureOwner();
  const releaseHydration = fixture.holdHydration();
  const replacement = fixture.notify({ event: 'SIGNED_IN', user: { userId: actorId }, sessionIdentity: `${actorId}:session-two` });
  assert.equal(fixture.state().hydratedAuthOwner, '');
  fixture.releaseBilling(0);
  for (let attempt = 0; attempt < 10 && fixture.state().hydrations.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fixture.state().hydrations.length, 1, 'the replacement hydration is already in flight');

  const recovery = fixture.recoverCommitted(staleOwner, { checkInCommitted: true, privatePayload: 'ignored' });
  await Promise.resolve();
  assert.equal(fixture.state().committedCheckInRefreshPending, 1);
  assert.equal(fixture.state().hydrations.length, 2, 'the postcommit read supersedes the precommit read');
  for (const hydration of fixture.state().hydrations) {
    assert.equal(hydration.owner, actorId);
    assert.equal(hydration.epoch, 8);
  }
  releaseHydration();
  assert.equal(await recovery, true);
  assert.equal(fixture.state().committedCheckInRefreshPending, 0);
  await replacement;
});

test('committed recovery never reads for an unrelated current actor or an uncommitted stale failure', async () => {
  const fixture = sessionFixture();
  await fixture.notify({ event: 'INITIAL_SESSION', user: { userId: actorId }, sessionIdentity: `${actorId}:session-one` });
  const staleOwner = fixture.captureOwner();
  assert.equal(await fixture.recoverCommitted(staleOwner, new Error('not committed')), false);

  const otherActor = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const replacement = fixture.notify({ event: 'SIGNED_IN', user: { userId: otherActor }, sessionIdentity: `${otherActor}:session-one` });
  assert.equal(await fixture.recoverCommitted(staleOwner, { checkInCommitted: true }), false);
  assert.equal(fixture.state().hydrations.length, 0);
  fixture.releaseBilling(0);
  await replacement;
  assert.equal(fixture.state().hydrations.length, 1);
  assert.equal(fixture.state().hydrations[0].owner, otherActor);
});

test('Dashboard invalidation clears only page-local optimistic state and both draft queues use the epoch fence', () => {
  const clearSource = sourceBetween('function clearDashboardUserState', 'function invalidateDashboardOwner');
  assert.match(clearSource, /pendingActionMutations\.clear\(\)/);
  assert.match(clearSource, /pendingWorkoutMutations\.clear\(\)/);
  assert.match(clearSource, /entrySaveQueue = Promise\.resolve\(\)/);
  assert.doesNotMatch(clearSource, /localStorage\.(?:clear|removeItem)|sessionStorage\.(?:clear|removeItem)/);

  assert.equal((dashboard.match(/\.then\(\(\) => runCurrentDraftMutation\(owner,/g) || []).length, 2);
  assert.match(dashboard, /subscribeToAuthStateChanges\(\(change\) => \{\s*void handleDashboardAuthStateChange\(change\)/);
  assert.match(authStateSource, /event !== 'INITIAL_SESSION'/);
  assert.match(authStateSource, /observedAuthSession !== nextSession/);
  assert.match(dashboard, /setAttribute\('aria-busy', String\(submissionPendingToday \|\| committedRefreshPending\)\)/);
});
