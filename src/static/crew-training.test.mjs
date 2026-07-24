import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREW_TRAINING_STEP_COUNT,
  CREW_TRAINING_VERSION,
  buildCrewTrainingSteps,
  crewTrainingActionLabel,
  normalizeCrewTrainingProgress,
} from './crew-training.mjs';

test('the creator syllabus has seven stable, ordered steps', () => {
  const steps = buildCrewTrainingSteps({ integrationsEnabled: true, crewName: 'San Marcos Men' });
  assert.equal(steps.length, CREW_TRAINING_STEP_COUNT);
  assert.deepEqual(steps.map((step) => step.id), [
    'crew-ready',
    'invite-people',
    'members-and-roles',
    'leaderboard-and-progress',
    'provider-purpose',
    'provider-connection',
    'safe-management',
  ]);
  assert.equal(steps[0].title, 'San Marcos Men is ready');
  assert.equal(steps[1].targetId, 'copyInviteButton');
  assert.equal(steps[2].targetId, 'crewMembersTitle');
  assert.equal(steps[3].targetId, 'crewLeaderboardTitle');
  assert.equal(steps[4].targetId, 'groupIntegrationsTitle');
  assert.equal(steps[6].targetId, 'crewLifecycleCard');
  assert.match(steps[1].description, /never creates or copies/i);
  assert.match(steps[6].description, /never selects/i);
});

test('safe-off mode keeps both provider lessons non-actionable and target-free', () => {
  const steps = buildCrewTrainingSteps({ integrationsEnabled: false });
  const providerSteps = steps.slice(4, 6);
  assert.deepEqual(providerSteps.map((step) => step.targetId), [null, null]);
  assert.deepEqual(providerSteps.map((step) => step.actionable), [false, false]);
  assert.match(providerSteps[0].description, /not currently available/i);
  assert.match(providerSteps[1].description, /no authorization/i);
});

test('enabled provider lessons explain consent, authorization, verification, and lifecycle', () => {
  const steps = buildCrewTrainingSteps({ integrationsEnabled: true });
  assert.match(steps[4].description, /member consent/i);
  assert.match(steps[4].description, /never sync back/i);
  assert.match(steps[5].description, /authorize/i);
  assert.match(steps[5].description, /verify the status/i);
  assert.match(steps[5].description, /reconnect and disconnect/i);
});

test('progress normalization accepts database keys and enforces monotonic bounds', () => {
  assert.deepEqual(normalizeCrewTrainingProgress({
    crew_id: 'crew-1',
    user_id: 'user-1',
    content_version: 2,
    status: 'in_progress',
    current_step: 3,
    furthest_step: 1,
    started_at: '2026-07-23T00:00:00Z',
  }), {
    crewId: 'crew-1',
    userId: 'user-1',
    contentVersion: 2,
    status: 'in_progress',
    currentStep: 3,
    furthestStep: 3,
    stepCount: CREW_TRAINING_STEP_COUNT,
    startedAt: '2026-07-23T00:00:00Z',
    skippedAt: null,
    completedAt: null,
    updatedAt: null,
  });
  assert.equal(normalizeCrewTrainingProgress({ status: 'completed' }).currentStep, 6);
  assert.equal(normalizeCrewTrainingProgress({ status: 'unknown', currentStep: 99 }).status, 'not_started');
  assert.equal(normalizeCrewTrainingProgress().contentVersion, CREW_TRAINING_VERSION);
});

test('launch copy exposes start, resume, and replay states', () => {
  assert.equal(crewTrainingActionLabel({ status: 'not_started' }), 'Start Crew Training');
  assert.equal(crewTrainingActionLabel({ status: 'in_progress' }), 'Resume Crew Training');
  assert.equal(crewTrainingActionLabel({ status: 'skipped' }), 'Resume Crew Training');
  assert.equal(crewTrainingActionLabel({ status: 'completed' }), 'Replay Crew Training');
});
