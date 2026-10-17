import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolveTrainingModulePreloads } from '../../vite.config.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {}); // Baseline code may never consume a synthetic gate.
  return { promise, resolve, reject };
};
const source = () => readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const operationSource = () => {
  const text = source();
  return text.slice(text.indexOf('async function queuePermanentRewardAndChallengeCelebrations'), text.indexOf('const pendingCelebrationRecoveries'));
};
const owner = { userId: 'owner-a', epoch: 1 };
const reward = { id: 'reward-a', kind: 'permanentReward', owner };

function operation({ rewards = [reward], gate = deferred(), current = owner } = {}) {
  const events = [];
  const scope = {
    current, presentPermanentRewardCelebration: null,
    isCurrentMutationOwner: value => value === scope.current,
    permanentRewardRecovery: { collect: async () => { events.push('claim'); return rewards; } },
    loadPermanentRewardCelebration: () => { events.push('load'); return gate.promise; },
    enqueueCelebrationItems: items => { if (items.length) events.push('enqueue'); },
    canParticipateInChallenge: () => true,
    refreshChallengeProgression: async () => { events.push('challenge'); },
    showRewardPresentationFailure: () => { events.push('guidance'); },
  };
  runInNewContext(operationSource(), scope);
  return { scope, events, gate, run: () => scope.queuePermanentRewardAndChallengeCelebrations(owner) };
}

test('permanent reward code stays unloaded for an empty claim and challenges still recover', async () => {
  const run = operation({ rewards: [] }); await run.run();
  assert.deepEqual(run.events, ['claim', 'challenge']);
});

test('permanent reward readiness is awaited before enqueue and challenge recovery', async () => {
  const run = operation(); const pending = run.run(); await new Promise(setImmediate);
  assert.deepEqual(run.events, ['claim', 'load']);
  const presenter = () => {};
  run.gate.resolve({ presentPermanentRewardCelebration: presenter }); await pending;
  assert.equal(run.scope.presentPermanentRewardCelebration, presenter);
  assert.deepEqual(run.events, ['claim', 'load', 'enqueue', 'challenge']);
});

for (const replacement of ['logout', 'other-user', 'same-user-session', 'return-to-same-user']) {
  for (const fails of [false, true]) test(`pending reward ${fails ? 'failure' : 'success'} is fenced after ${replacement}`, async () => {
    const run = operation(); const pending = run.run(); await new Promise(setImmediate);
    run.scope.current = replacement === 'logout' ? null : { userId: replacement === 'other-user' ? 'owner-b' : owner.userId, epoch: 2 };
    if (fails) run.gate.reject(new Error('private module detail'));
    else run.gate.resolve({ presentPermanentRewardCelebration() {} });
    await pending;
    assert.deepEqual(run.events, ['claim', 'load']);
    assert.equal(run.scope.presentPermanentRewardCelebration, null);
  });
}

test('a current-owner renderer failure neither enqueues nor acknowledges and cannot block challenge recovery', async () => {
  const run = operation(); const pending = run.run(); await new Promise(setImmediate);
  run.gate.reject(new Error('untrusted module location')); await pending;
  assert.deepEqual(run.events, ['claim', 'load', 'guidance', 'challenge']);
  assert.equal(run.scope.presentPermanentRewardCelebration, null);
});

test('an already-stale owner cannot dispatch any reward or challenge work', async () => {
  const run = operation({ current: null }); await run.run(); assert.deepEqual(run.events, []);
});

test('renderer code-only loader shares one import without loading eagerly', async () => {
  const { createPermanentRewardCelebrationLoader } = await import('./reward-celebration-view-loader.mjs');
  const gate = deferred(); let calls = 0;
  const load = createPermanentRewardCelebrationLoader({ loadModule: () => { calls++; return gate.promise; } });
  assert.equal(calls, 0); const first = load(); assert.equal(load(), first);
  await Promise.resolve(); assert.equal(calls, 1);
  const module = { presentPermanentRewardCelebration() {} }; gate.resolve(module);
  assert.equal(await first, module); assert.equal(await load(), module); assert.equal(calls, 1);
});

for (const cause of ['JS rejection', 'CSS rejection', 'invalid module', 'timeout']) test(`renderer ${cause} stays failed without automatic retry or late publication`, async () => {
  const { createPermanentRewardCelebrationLoader, REWARD_PRESENTATION_RELOAD_MESSAGE } = await import('./reward-celebration-view-loader.mjs');
  const gate = deferred(); let calls = 0, expire, clears = 0;
  const load = createPermanentRewardCelebrationLoader({ loadModule: () => { calls++; return gate.promise; },
    setTimer: (callback, milliseconds) => { assert.equal(milliseconds, 30000); expire = callback; return 7; },
    clearTimer: timer => { assert.equal(timer, 7); clears++; },
  });
  const first = load(); const rejection = assert.rejects(first, { message: REWARD_PRESENTATION_RELOAD_MESSAGE });
  await Promise.resolve();
  if (cause === 'timeout') expire();
  else if (cause === 'invalid module') gate.resolve({});
  else gate.reject(new Error(cause));
  await rejection;
  if (cause === 'timeout') gate.resolve({ presentPermanentRewardCelebration() { assert.fail('late presentation'); } });
  await new Promise(setImmediate);
  assert.equal(load(), first); await assert.rejects(load(), { message: REWARD_PRESENTATION_RELOAD_MESSAGE });
  assert.equal(calls, 1); assert.equal(clears, 1);
});

test('renderer preload recovery removes only its JS preload, not CSS or shared dependencies', () => {
  const target = 'assets/reward-celebration-view-example.js';
  const dependencies = [target, 'assets/menu-example.js', 'assets/reward-celebration-view-example.css'];
  assert.deepEqual(resolveTrainingModulePreloads(target, dependencies, { hostType: 'js' }), dependencies.slice(1));
  assert.equal(resolveTrainingModulePreloads(target, dependencies, { hostType: 'html' }), dependencies);
});

for (const committedRefreshPending of [false, true]) for (const submittedToday of [false, true]) test(`pending post display submitted=${submittedToday} recovery=${committedRefreshPending}`, () => {
  const text = source();
  const body = text.slice(text.indexOf('  if (checkInButton) {'), text.indexOf('  if (countdownCheckInButton) {'));
  const checkInButton = { classList: { toggle() {} } }, attributes = {};
  const checkInStatus = { classList: { toggle() {} }, setAttribute: (key, value) => { attributes[key] = value; } };
  runInNewContext(body, { checkInButton, checkInStatus, submittedToday, dailyDraftBusy: false,
    hasPostableCheckIn: false, submissionPendingToday: true, committedRefreshPending,
    checkInNoticeDate: 'today', entry: { date: 'today' }, checkInNotice: submittedToday ? 'Posted' : 'Posting',
    previewChallengeMode: () => false, challengeActivation: { readState: 'ready', status: 'active' }, checkInStatusReady: true });
  assert.equal(checkInButton.disabled, true);
  assert.equal(checkInButton.textContent, committedRefreshPending ? 'Refreshing...' : submittedToday ? 'Today’s Check-In Complete' : 'Posting...');
  assert.equal(attributes['aria-busy'], String(!submittedToday || committedRefreshPending));
});

test('optional presentation cannot keep the initial authorized page hidden or alter claim APIs', () => {
  const text = source(), boot = text.slice(text.indexOf('async function bootDashboard()'));
  assert(boot.indexOf('requestAnimationFrame(() => initReveal())') < boot.indexOf('await recoverPendingCelebrations()'));
  assert.doesNotMatch(text, /import \{ presentPermanentRewardCelebration \} from/);
  assert.match(text, /if \(submissionCommitted\) showCommittedCheckInStatus\(submissionOwner, entry.date\);\n    await queuePermanentRewardAndChallengeCelebrations\(submissionOwner\);/);
  assert.doesNotMatch(text.slice(text.indexOf('    queueCheckInCelebrations({'), text.indexOf('  } catch (error) {', text.indexOf('    queueCheckInCelebrations({'))), /\brender\(\)/);
  assert.doesNotMatch(operationSource(), /acknowledgeReward|\.complete\(|\.release\(/);
});

for (const current of [false, true]) for (const submitted of [false, true]) {
  test(`status-only publication requires current=${current} and submitted=${submitted}, never unlocks preview controls`, () => {
    const text = source();
    const helper = text.slice(text.indexOf('function showCommittedCheckInStatus'), text.indexOf('const presentCelebrationItem'));
    const writes = [];
    const button = { textContent: 'Posting...', disabled: true, classList: { add: value => writes.push(value) } };
    const status = { textContent: 'Posting', classList: button.classList, setAttribute: (key, value) => writes.push([key, value]) };
    const scope = { isCurrentMutationOwner: () => current, hasSubmittedCheckIn: date => { assert.equal(date, 'old-day'); return submitted; },
      checkInNoticeDate: 'advanced-day', checkInNotice: 'Next day ready',
      $: id => { assert(['checkInButton', 'checkInStatus'].includes(id)); return id === 'checkInButton' ? button : status; },
    };
    runInNewContext(helper, scope); scope.showCommittedCheckInStatus(owner, 'old-day');
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, current && submitted ? 'Today’s Check-In Complete' : 'Posting...');
    assert.equal(status.textContent, current && submitted ? 'Your check-in is posted. Your rewards are loading.' : 'Posting');
    if (!current || !submitted) assert.deepEqual(writes, []);
  });
}
