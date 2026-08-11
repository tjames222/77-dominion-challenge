import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/community.css', import.meta.url), 'utf8');
const community = readFileSync(new URL('./community.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source boundary: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('crew training exposes an accessible seven-step coachmark shell', () => {
  for (const id of [
    'crewTrainingButton',
    'crewTrainingLayer',
    'crewTrainingCoachmark',
    'crewTrainingProgress',
    'crewTrainingTitle',
    'crewTrainingDescription',
    'crewTrainingBack',
    'crewTrainingSkip',
    'crewTrainingNext',
    'crewTrainingClose',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-labelledby="crewTrainingTitle"/);
  assert.match(html, /id="crewTrainingTitle" tabindex="-1"/);
  assert.match(css, /\.crew-training-actions button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
});

test('page load reads training progress but never claims or opens it', () => {
  const loader = sourceBetween(
    community,
    'async function loadCrewTrainingProgress()',
    'async function openCrewTraining(',
  );
  const boot = sourceBetween(
    community,
    'async function bootCommunity()',
    'function setCrewFormOpen(',
  );
  assert.match(loader, /getCrewTrainingProgress\(/);
  assert.doesNotMatch(loader, /claimCrewTraining\(/);
  assert.doesNotMatch(loader, /openCrewTraining\(/);
  assert.doesNotMatch(boot, /claimCrewTraining\(/);
  assert.doesNotMatch(boot, /openCrewTraining\(/);
});

test('automatic claim happens only after create and authoritative refresh', () => {
  const submit = sourceBetween(
    community,
    "$('crewForm')?.addEventListener('submit'",
    "$('journalDate')?.addEventListener",
  );
  const refreshIndex = submit.indexOf('await refreshCrews()');
  const claimIndex = submit.indexOf('await claimCrewTraining(');
  const openIndex = submit.indexOf('await openCrewTraining(');
  assert.ok(refreshIndex >= 0);
  assert.ok(claimIndex > refreshIndex);
  assert.ok(openIndex > claimIndex);
  assert.match(submit, /if \(crew\.createdNew && authoritativeCrew\?\.id === crew\.id && isCrewLeader\(\)\)/);
  assert.match(submit, /if \(trainingProgress\.claimedNow\)/);
});

test('back, close, and replay navigation cannot write server progress', () => {
  const listeners = sourceBetween(
    community,
    "$('crewTrainingButton')?.addEventListener",
    "$('crewLifecycleButton')?.addEventListener",
  );
  const close = sourceBetween(
    community,
    'function closeCrewTraining(',
    'function crewTrainingTargetForStep(',
  );
  const forward = sourceBetween(
    community,
    'async function moveCrewTrainingForward()',
    'async function skipCrewTraining()',
  );
  assert.doesNotMatch(listeners, /advanceCrewTraining\(/);
  assert.doesNotMatch(close, /advanceCrewTraining\(|claimCrewTraining\(/);
  assert.ok(forward.indexOf("if (state.trainingMode === 'replay')") < forward.indexOf('await advanceCrewTraining({'));
});

test('progress uses only the versioned training RPCs and is cleared with mock membership', () => {
  assert.match(api, /client\.rpc\('get_crew_training_progress'/);
  assert.match(api, /client\.rpc\('claim_crew_training'/);
  assert.match(api, /client\.rpc\('advance_crew_training'/);
  assert.match(api, /target_content_version:\s*contentVersion/);
  assert.equal((api.match(/clearMockCrewTraining\(crewId\);/g) || []).length, 1);
  assert.equal((api.match(/clearMockCrewTraining\(crewId, userId\);/g) || []).length, 1);
});
