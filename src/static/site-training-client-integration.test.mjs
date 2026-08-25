import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('site training client integration', () => {
  test('binds reads and every mutation to the captured actor and strict response contract', async () => {
    const api = await read('./api.js');
    const surface = api.slice(
      api.indexOf('export async function getSiteTrainingState'),
      api.indexOf('const rpcDraft'),
    );
    assert.equal((surface.match(/requireCapturedSiteTrainingActor\(expectedUserId\)/g) || []).length, 3);
    assert.equal((surface.match(/const user = await requireUser\(actorId\)/g) || []).length, 3);
    assert.match(surface, /expectedPage: page, expectedProgram: program/);
    assert.match(surface, /target_expected_actor_id: user\.id/);
    assert.match(surface, /return siteTrainingReadError\(error\)/);
    assert.equal((surface.match(/normalizeSiteTrainingResult\(data, page, operation\.program, operation\)/g) || []).length, 2);
  });

  test('keeps preview reads side-effect free and request replays ahead of revision checks', async () => {
    const api = await read('./api.js');
    const reader = api.slice(
      api.indexOf('function readMockSiteTrainingStore'),
      api.indexOf('function createMockSiteTrainingOverall'),
    );
    const runner = api.slice(
      api.indexOf('function runMockSiteTrainingOperation'),
      api.indexOf('function siteTrainingRpcParameters'),
    );
    assert.match(reader, /peekPreviewUserValue\(localStorage/);
    assert.match(api, /function withMockSiteTrainingAttemptParity/);
    assert.match(api, /page: withMockSiteTrainingAttemptParity\(prior\.result\?\.page\)/);
    assert.match(api, /readMockSiteTrainingStore\(actorId, \{ readOnly: true \}\)/);
    assert.ok(runner.indexOf('const prior = requests[operation.requestId]') < runner.indexOf('if (revision !== operation.expectedRevision)'));
    assert.ok(runner.indexOf('const prior = requests[operation.requestId]') < runner.indexOf('current.page.revision !== operation.expectedPageRevision'));
    assert.match(runner, /prior\.signature !== signature/);
    assert.match(runner, /siteTrainingRequestReuseError\(\)/);
    assert.match(runner, /siteTrainingStaleRevisionError\(\)/);
    assert.match(api, /target_expected_page_revision: expectedPageRevision/);
    assert.match(runner, /if \(operation\.scope === 'overall'\)/);
  });

  test('never auto-opens or auto-claims while hydrating and keeps replay client-only', async () => {
    const runtime = await read('./site-training-runtime.mjs');
    assert.equal((runtime.match(/expectedPageRevision: current\.page\.revision/g) || []).length, 3);
    const hydrate = runtime.slice(
      runtime.indexOf('const hydrate = async'),
      runtime.indexOf('const claim = async'),
    );
    const replay = runtime.slice(
      runtime.indexOf('replay({'),
      runtime.indexOf('setActor('),
    );
    assert.match(hydrate, /service\.getSiteTrainingState/);
    assert.doesNotMatch(hydrate, /claimSiteTraining|\.open\(/);
    assert.doesNotMatch(replay, /claimSiteTraining|transitionSiteTraining/);
    assert.match(replay, /replayIndex = 0/);
  });

  test('keeps restart page-only and exposes observable runtime state for controls', async () => {
    const [api, runtime] = await Promise.all([
      read('./api.js'),
      read('./site-training-runtime.mjs'),
    ]);
    const transition = api.slice(
      api.indexOf('export async function transitionSiteTraining'),
      api.indexOf('const rpcDraft'),
    );
    assert.match(transition, /operation\.action === 'restart' && operation\.scope !== 'page'/);
    assert.match(transition, /Restart is available only for current page training/);
    assert.match(api, /result\.page\.revision !== operation\.expectedPageRevision \+ 1/);
    assert.match(runtime, /scope: 'page',\s+action: 'restart'/);
    assert.match(runtime, /restart,/);
    assert.match(runtime, /subscribe\(listener\)/);
    assert.match(runtime, /busy: pendingMutation !== null/);
    assert.match(runtime, /if \(onStateChange\) controller\.subscribe\(onStateChange\)/);
  });
});
