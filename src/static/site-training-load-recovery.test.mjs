import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSiteTrainingLoadRecovery, TRAINING_RELOAD_MESSAGE } from './site-training-load-recovery.mjs';
import { loadSiteTrainingUi, TRAINING_RELOAD_REQUIRED } from './site-training-ui-loader.mjs';

function fixture() {
  let reloads = 0;
  let options;
  let destroys = 0;
  const opens = [];
  const recovery = createSiteTrainingLoadRecovery({
    id: 'test-training-reload',
    window: { location: { reload() { reloads += 1; } } },
    confirmationFactory(input) {
      options = input;
      return { open(trigger) { opens.push(trigger); }, destroy() { destroys += 1; } };
    },
  });
  return { recovery, opens, get options() { return options; }, get reloads() { return reloads; }, get destroys() { return destroys; } };
}

test('the real loader keeps a failed import promise and exposes only fixed recovery copy', async () => {
  // Node cannot import the UI stylesheet; the browser tests also abort actual
  // JS/CSS requests in Chromium and WebKit, then recover with a new document.
  const first = loadSiteTrainingUi();
  await assert.rejects(first, { code: TRAINING_RELOAD_REQUIRED, message: TRAINING_RELOAD_MESSAGE });
  assert.equal(loadSiteTrainingUi(), first);
  await assert.rejects(loadSiteTrainingUi(), { code: TRAINING_RELOAD_REQUIRED });
});

test('unrelated failures do not offer or perform a reload', () => {
  const f = fixture();
  assert.equal(f.recovery.record(new Error('Temporary API failure')), false);
  assert.equal(f.recovery.open({}), false);
  assert.equal(f.reloads, 0);
  assert.equal(f.options, undefined);
});

test('classified failure requires a separate explicit confirmation and warns about unsaved changes', () => {
  const f = fixture();
  assert.equal(f.recovery.record({ code: TRAINING_RELOAD_REQUIRED }), true);
  const trigger = {};
  assert.equal(f.recovery.open(trigger), true);
  assert.deepEqual(f.opens, [trigger]);
  assert.equal(f.reloads, 0);
  assert.match(f.options.description, /discard unsaved changes/);
  assert.match(f.options.description, /saved training progress will not be reset/);
  assert.equal(f.options.cancelLabel, 'Keep editing');
  assert.equal(f.options.initialFocus, undefined, 'The shared confirmation defaults to Cancel, not Confirm.');
  f.options.onConfirm();
  assert.equal(f.reloads, 1);
});

test('reattaching controls dismisses the dialog but preserves the document failure', () => {
  const f = fixture();
  f.recovery.record({ code: TRAINING_RELOAD_REQUIRED });
  f.recovery.open({});
  f.recovery.dismiss();
  assert.equal(f.destroys, 1);
  assert.equal(f.recovery.required, true);
  assert.equal(f.reloads, 0);
  assert.equal(f.recovery.open({}), true);
});

test('account/controller destruction prevents an abandoned confirmation from reloading', () => {
  const f = fixture();
  f.recovery.record({ code: TRAINING_RELOAD_REQUIRED });
  f.recovery.open({});
  f.recovery.destroy();
  f.options.onConfirm();
  assert.equal(f.reloads, 0);
  assert.equal(f.recovery.open({}), false);
  assert.equal(f.destroys, 1);
});
