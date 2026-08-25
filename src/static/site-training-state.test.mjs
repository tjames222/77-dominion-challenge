import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defineSiteTrainingRegistry } from './site-training-registry.mjs';
import {
  applySiteTrainingTransition,
  createSiteTrainingPageProgress,
  newSiteTrainingRequestId,
  normalizeSiteTrainingMutation,
  normalizeSiteTrainingState,
  reconcileSiteTrainingContentVersion,
} from './site-training-state.mjs';

const page = defineSiteTrainingRegistry({ pages: [{
  id: 'framework-page', route: '/dashboard.html', contentVersion: 1, title: 'Framework',
  steps: ['one', 'two', 'three'].map((id) => ({
    id, title: id, description: `${id} description`, unavailable: { description: `${id} fallback` },
  })),
}] }).pages[0];

describe('site training state contract', () => {
  test('fails closed for malformed or mismatched server payloads', () => {
    assert.equal(normalizeSiteTrainingState({}).contractValid, false);
    const initial = createSiteTrainingPageProgress(page, 'actor-1');
    assert.equal(normalizeSiteTrainingState(initial, { expectedPage: page }).contractValid, true);
    const missingAttempt = structuredClone(initial);
    delete missingAttempt.page.attemptNumber;
    assert.equal(normalizeSiteTrainingState(missingAttempt, { expectedPage: page }).contractValid, false);
    const unclaimedAttempt = structuredClone(initial);
    unclaimedAttempt.page.attemptNumber = 1;
    assert.equal(normalizeSiteTrainingState(unclaimedAttempt, { expectedPage: page }).contractValid, false);
    const claimedWithoutAttempt = applySiteTrainingTransition(initial, 'start');
    claimedWithoutAttempt.page.attemptNumber = 0;
    assert.equal(normalizeSiteTrainingState(claimedWithoutAttempt, { expectedPage: page }).contractValid, false);
    assert.throws(() => normalizeSiteTrainingMutation(initial, { expectedPage: page }), {
      code: 'SITE_TRAINING_CONTRACT_INVALID',
    });
    const missingRevision = structuredClone(initial);
    missingRevision.page.revision = null;
    assert.equal(normalizeSiteTrainingState(missingRevision, { expectedPage: page }).contractValid, false);
    const raw = createSiteTrainingPageProgress(page, 'actor-1');
    raw.page.route = '/profile.html';
    assert.equal(normalizeSiteTrainingState(raw, { expectedPage: page }).contractValid, false);
    assert.throws(() => normalizeSiteTrainingMutation(raw, { expectedPage: page }), {
      code: 'SITE_TRAINING_CONTRACT_INVALID',
    });
  });

  test('persists every live transition while Back preserves furthest progress', () => {
    let state = createSiteTrainingPageProgress(page, 'actor-1');
    state = applySiteTrainingTransition(state, 'start', { now: '2026-08-05T00:00:00.000Z' });
    assert.equal(state.claimedNow, true);
    assert.equal(state.page.attemptNumber, 1);
    state = applySiteTrainingTransition(state, 'next', { targetStepId: 'two', now: '2026-08-05T00:00:01.000Z' });
    assert.equal(state.claimedNow, false);
    state = applySiteTrainingTransition(state, 'back', { targetStepId: 'one', now: '2026-08-05T00:00:02.000Z' });
    assert.equal(state.page.currentStepIndex, 0);
    assert.equal(state.page.furthestStepIndex, 1);
    assert.equal(state.page.revision, 3);
    state = applySiteTrainingTransition(state, 'stop', { now: '2026-08-05T00:00:03.000Z' });
    state = applySiteTrainingTransition(state, 'resume', { now: '2026-08-05T00:00:04.000Z' });
    assert.equal(state.page.status, 'in_progress');
    assert.equal(state.page.revision, 5);
  });

  test('restarts only unfinished training as a fresh page-scoped attempt', () => {
    let state = applySiteTrainingTransition(
      createSiteTrainingPageProgress(page, 'actor-1'),
      'start',
      { now: '2026-08-05T00:00:00.000Z' },
    );
    state = applySiteTrainingTransition(state, 'next', {
      targetStepId: 'two',
      now: '2026-08-05T00:00:01.000Z',
    });
    state = applySiteTrainingTransition(state, 'stop', { now: '2026-08-05T00:00:02.000Z' });
    state = applySiteTrainingTransition(state, 'restart', { now: '2026-08-05T00:00:03.000Z' });
    assert.deepEqual({
      status: state.page.status,
      currentStepId: state.page.currentStepId,
      currentStepIndex: state.page.currentStepIndex,
      furthestStepIndex: state.page.furthestStepIndex,
      attemptNumber: state.page.attemptNumber,
      revision: state.page.revision,
      startedAt: state.page.startedAt,
      stoppedAt: state.page.stoppedAt,
      completedAt: state.page.completedAt,
    }, {
      status: 'in_progress',
      currentStepId: 'one',
      currentStepIndex: 0,
      furthestStepIndex: 0,
      attemptNumber: 2,
      revision: 4,
      startedAt: '2026-08-05T00:00:03.000Z',
      stoppedAt: null,
      completedAt: null,
    });
    assert.equal(state.page.completionCount, 0);
    assert.throws(
      () => applySiteTrainingTransition(createSiteTrainingPageProgress(page, 'actor-1'), 'restart'),
      /unfinished/,
    );
  });

  test('finishes only on the final step and retains immutable completion evidence', () => {
    let state = applySiteTrainingTransition(
      createSiteTrainingPageProgress(page, 'actor-1'),
      'start',
      { now: '2026-08-05T00:00:00.000Z' },
    );
    assert.throws(() => applySiteTrainingTransition(state, 'finish'), /final/);
    state = applySiteTrainingTransition(state, 'next', { targetStepId: 'two' });
    state = applySiteTrainingTransition(state, 'next', { targetStepId: 'three' });
    state = applySiteTrainingTransition(state, 'finish');
    assert.equal(state.page.status, 'completed');
    assert.equal(state.page.everCompleted, true);
    assert.equal(state.page.completionCount, 1);
    assert.throws(() => applySiteTrainingTransition(state, 'restart'), /unfinished/);
  });

  test('reconciles a new content version by stable ID and safely falls back to step one', () => {
    let prior = applySiteTrainingTransition(createSiteTrainingPageProgress(page, 'actor-1'), 'start');
    prior = applySiteTrainingTransition(prior, 'next', { targetStepId: 'two' });
    const retainedPage = { ...page, contentVersion: 2 };
    const retained = reconcileSiteTrainingContentVersion(prior, retainedPage, 'actor-1');
    assert.equal(retained.page.status, 'stopped');
    assert.equal(retained.page.currentStepId, 'two');
    assert.equal(retained.page.revision, 1);
    assert.equal(retained.page.attemptNumber, 1);

    const removedPage = {
      ...retainedPage,
      contentVersion: 3,
      steps: retainedPage.steps.filter((step) => step.id !== 'two'),
    };
    const reset = reconcileSiteTrainingContentVersion(prior, removedPage, 'actor-1');
    assert.equal(reset.page.currentStepId, 'one');
    assert.equal(reset.page.status, 'stopped');
    assert.equal(reset.page.revision, 1);
  });

  test('issues unique UUID-v4 idempotency keys', () => {
    const ids = Array.from({ length: 100 }, newSiteTrainingRequestId);
    assert.equal(new Set(ids).size, ids.length);
    ids.forEach((id) => assert.match(id, /^[0-9a-f-]{36}$/i));
  });
});
