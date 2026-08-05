import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const api = read('./api.js');
const auth = read('./auth.js');
const billing = read('./billing.js');
const community = read('./community.js');
const invite = read('./invite.js');
const dashboardStartFlow = read('./challenge-start-flow.mjs');
const migration = read('../../supabase/migrations/20260805010103_integrate_group_challenge_start.sql');

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source boundary: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

describe('Group challenge start integration', () => {
  test('existing membership requires confirmation and page hydration never activates', () => {
    const boot = sourceBetween(community, 'async function bootCommunity()', 'function setCrewFormOpen(');
    const confirmation = sourceBetween(
      community,
      'function openGroupStartConfirmation(',
      'async function resumeGroupChallengeStart()',
    );

    assert.doesNotMatch(boot, /activateGroupChallenge\(/);
    assert.match(confirmation, /createConfirmationDialog\(/);
    assert.match(confirmation, /onConfirm:\s*async \(\) =>/);
    assert.match(confirmation, /await activateGroupChallenge\(/);
    assert.match(confirmation, /onCancel:\s*\(\) => abandonGroupChallengeStart\(\)/);
    assert.match(community, /clearChallengeStartIntent\(sessionStorage\)/);
  });

  test('crew creation and Group activation share one atomic database boundary', () => {
    const submit = sourceBetween(
      community,
      "$('crewForm')?.addEventListener('submit'",
      "$('journalDate')?.addEventListener",
    );
    const combinedApi = sourceBetween(
      api,
      'export async function createCrewAndActivateGroup(',
      'function defaultCrewTrainingProgress(',
    );

    assert.match(submit, /if \(startingGroupChallenge\)[\s\S]*createCrewAndActivateGroup\(/);
    assert.match(submit, /else \{[\s\S]*crew = await createCrew\(/);
    assert.match(combinedApi, /client\.rpc\('create_crew_and_activate_group'/);
    assert.match(combinedApi, /target_expected_actor_id:\s*user\.id/);
    assert.match(migration, /security definer/);
    assert.match(migration, /from public\.create_crew\(/);
    assert.match(migration, /public\.activate_group_challenge\(/);
    assert.match(migration, /grant execute[\s\S]*to authenticated/);
  });

  test('invite activation is sequenced strictly after successful membership confirmation', () => {
    const confirmListener = sourceBetween(
      invite,
      "$('confirmInviteButton')?.addEventListener('click'",
      "$('retryInviteButton')?.addEventListener",
    );
    const confirmIndex = confirmListener.indexOf('await confirmCrewInvite(');
    const acceptedStatusIndex = confirmListener.indexOf("['joined', 'already_member'].includes(response.status)");
    const armIndex = confirmListener.indexOf('await armStartAfterMembership(');
    const activateIndex = confirmListener.indexOf('await continueGroupChallengeStart()');

    assert.ok(confirmIndex >= 0);
    assert.ok(acceptedStatusIndex > confirmIndex);
    assert.ok(armIndex > acceptedStatusIndex);
    assert.ok(activateIndex > armIndex);
    assert.match(api, /confirmCrewInvite\(continuationToken, \{ expectedUserId = '' \} = \{\}\)/);
    assert.match(api, /await requireUser\(expectedUserId\)/);
  });

  test('auth and billing preserve only the session-backed fixed continuation marker', () => {
    assert.match(auth, /isChallengeStartReturnPath\(returnTo\)/);
    assert.match(auth, /buildChallengeStartAuthHref\(/);
    assert.match(billing, /readChallengeStartIntent\(sessionStorage\)/);
    assert.match(billing, /return CHALLENGE_START_INTENT_PATH/);
    assert.doesNotMatch(billing, /crewId=.*challenge-start/);
    assert.match(dashboardStartFlow, /GROUP_CHALLENGE_START_HREF = CHALLENGE_START_INTENT_PATH/);
  });

  test('creator training remains owner-gated and invite completion never claims it', () => {
    const submit = sourceBetween(
      community,
      "$('crewForm')?.addEventListener('submit'",
      "$('journalDate')?.addEventListener",
    );
    assert.match(submit, /crew\.createdNew[\s\S]*isCrewLeader\(\)[\s\S]*claimCrewTraining\(/);
    assert.doesNotMatch(invite, /claimCrewTraining|openCrewTraining/);
  });
});
