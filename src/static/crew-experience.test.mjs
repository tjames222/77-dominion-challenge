import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertSingleCrew,
  crewLifecycleAction,
  crewViewState,
} from './crew-experience.mjs';

const communityHtml = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
const communityJs = readFileSync(new URL('./community.js', import.meta.url), 'utf8');
const apiJs = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const communityCss = readFileSync(new URL('../assets/community.css', import.meta.url), 'utf8');

test('single-crew guard rejects ambiguity instead of picking a membership', () => {
  assert.deepEqual(assertSingleCrew([]), []);
  assert.equal(assertSingleCrew([{ id: 'one' }])[0].id, 'one');
  assert.throws(
    () => assertSingleCrew([{ id: 'one' }, { id: 'two' }]),
    /more than one active crew/i,
  );
});

test('empty and active single-crew views are mutually exclusive', () => {
  assert.deepEqual(crewViewState(), {
    showCreateCard: false,
    showCreateButton: false,
    showCreateForm: false,
    showActiveCrew: false,
  });
  assert.equal(crewViewState({ loaded: true }).showCreateButton, true);
  assert.equal(crewViewState({ loaded: true, createFormOpen: true }).showCreateForm, true);
  assert.equal(crewViewState({ loaded: true, crew: { id: 'one' } }).showActiveCrew, true);
  assert.equal(crewLifecycleAction('owner'), 'delete');
  assert.equal(crewLifecycleAction('admin'), 'delete');
  assert.equal(crewLifecycleAction('member'), 'leave');
});

test('crew UI starts collapsed and shows one active crew without a switcher', () => {
  assert.match(communityHtml, /id="crewCreateCard" hidden/);
  assert.match(communityHtml, /id="openCrewFormButton"[\s\S]+aria-expanded="false"/);
  assert.match(communityHtml, /id="crewForm" hidden/);
  assert.match(communityHtml, /id="cancelCrewFormButton"/);
  assert.match(communityHtml, /id="activeCrewName"/);
  assert.doesNotMatch(communityHtml, /id="crewSelect"/);
  assert.match(communityHtml, /id="crewLifecycleCard"/);
});

test('all lifecycle writes use hardened RPCs and retry-stable request IDs', () => {
  assert.match(apiJs, /client\.rpc\('create_crew'/);
  assert.match(apiJs, /client\.rpc\('delete_crew'/);
  assert.match(apiJs, /client\.rpc\('leave_crew'/);
  assert.doesNotMatch(apiJs, /\.from\('crews'\)\s*\n\s*\.insert/);
  assert.match(communityJs, /state\.createRequestId \|\|= newCrewLifecycleRequestId\(\)/);
});

test('destructive flow uses the shared accessible confirmation pattern', () => {
  assert.match(communityJs, /createConfirmationDialog\(\{/);
  assert.match(communityJs, /title: 'Are you sure\?'/);
  assert.match(communityJs, /cancelLabel: 'Cancel'/);
  assert.match(communityJs, /destructive: true/);
  assert.match(communityJs, /alert: true/);
  assert.match(communityCss, /button\.destructive/);
  assert.match(communityCss, /min-height: 44px/);
});
