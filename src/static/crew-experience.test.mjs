import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CREW_TRAINING_VERSION,
  assertSingleCrew,
  buildCrewTrainingSteps,
  crewLifecycleAction,
  crewTrainingActionLabel,
  crewViewState,
  integrationsEnabled,
  normalizeCrewTrainingProgress,
  shouldAutoStartCrewTraining,
} from './crew-experience.mjs';

const communityHtml = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
const communityJs = readFileSync(new URL('./community.js', import.meta.url), 'utf8');

test('single-crew guard rejects ambiguous memberships instead of choosing one', () => {
  assert.deepEqual(assertSingleCrew([]), []);
  assert.equal(assertSingleCrew([{ id: 'crew-1' }])[0].id, 'crew-1');
  assert.throws(
    () => assertSingleCrew([{ id: 'crew-1' }, { id: 'crew-2' }]),
    /more than one active crew/i,
  );
});

test('crew view exposes one collapsed create entry point only after loading', () => {
  assert.deepEqual(crewViewState(), {
    showCreateCard: false,
    showCreateButton: false,
    showCreateForm: false,
    showActiveCrew: false,
  });
  assert.equal(crewViewState({ loaded: true }).showCreateButton, true);
  assert.equal(crewViewState({ loaded: true, createFormOpen: true }).showCreateForm, true);
  assert.equal(crewViewState({ loaded: true, crew: { id: 'crew-1' } }).showActiveCrew, true);
});

test('lifecycle action is role-specific', () => {
  assert.equal(crewLifecycleAction('owner'), 'delete');
  assert.equal(crewLifecycleAction('admin'), 'delete');
  assert.equal(crewLifecycleAction('member'), 'leave');
});

test('provider controls are safe off unless explicitly enabled', () => {
  assert.equal(integrationsEnabled(undefined), false);
  assert.equal(integrationsEnabled('false'), false);
  assert.equal(integrationsEnabled('TRUE'), true);
});

test('training is creator-only, resumable, versioned, and safe-off aware', () => {
  const progress = normalizeCrewTrainingProgress({ status: 'in_progress', current_step: 99 });
  assert.equal(progress.version, CREW_TRAINING_VERSION);
  assert.equal(progress.currentStep, 6);
  assert.equal(crewTrainingActionLabel(progress), 'Resume Crew Training');
  assert.equal(shouldAutoStartCrewTraining({ createdNew: true, role: 'member' }), false);
  assert.equal(shouldAutoStartCrewTraining({ createdNew: true, role: 'owner' }), true);

  const safeOffSteps = buildCrewTrainingSteps({ crewName: 'North Star', providersEnabled: false });
  assert.equal(safeOffSteps.length, 7);
  assert.match(safeOffSteps[0].title, /North Star/);
  assert.match(safeOffSteps[5].body, /safely off/i);
  assert.equal(safeOffSteps[5].targetId, '');

  const enabledSteps = buildCrewTrainingSteps({ providersEnabled: true });
  assert.equal(enabledSteps[5].targetId, 'integrationConnectActions');
  assert.match(enabledSteps[5].body, /Authorize Slack or Discord/);
});

test('crew UI starts collapsed and replaces the multi-crew selector with one active crew', () => {
  assert.match(communityHtml, /id="crewCreateCard" hidden/);
  assert.match(communityHtml, /id="openCrewFormButton"[^>]+aria-expanded="false"/);
  assert.match(communityHtml, /id="crewForm" hidden/);
  assert.match(communityHtml, /id="activeCrewName"/);
  assert.doesNotMatch(communityHtml, /id="crewSelect"/);
  assert.match(communityHtml, /id="crewLifecycleDialog"[\s\S]+Are you sure\?/);
  assert.match(communityJs, /trapDialogFocus/);
});

test('invite and provider actions use branded controls with recognizable local marks', () => {
  assert.match(communityHtml, /invite-people-button[\s\S]+Invite People/);
  assert.match(communityHtml, /provider-mark-slack[\s\S]+<svg[\s\S]+Connect Slack/);
  assert.match(communityHtml, /provider-mark-discord[\s\S]+<svg[\s\S]+Connect Discord/);
  assert.match(communityHtml, /id="crewIntegrationsCard"[^>]+hidden/);
  assert.match(communityJs, /GROUP_INTEGRATIONS_ENABLED = integrationsEnabled/);
  assert.match(communityJs, /if \(!GROUP_INTEGRATIONS_ENABLED \|\| !crew\)/);
});
