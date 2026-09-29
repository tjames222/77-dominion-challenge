import {
  applySiteTrainingTransition,
  createSiteTrainingPageProgress,
  normalizeSiteTrainingMutation,
  normalizeSiteTrainingState,
  reconcileSiteTrainingContentVersion,
  siteTrainingReadError,
} from './site-training-state.mjs';
import { newSiteTrainingRequestId } from './site-training-request-id.mjs';

const MOCK_SITE_TRAINING_PROGRESS_KEY = 'dominion:siteTrainingProgress';
const MOCK_SITE_TRAINING_REQUESTS_KEY = 'dominion:siteTrainingRequests';

// One call owns its guards; all durable preview state and in-flight read state
// remain in the injected existing stores. Construction performs no I/O.
export function createSiteTrainingApi({
  isLocalDemoMode, requireHybridPreviewUser, getMockUserId, requireSupabase,
  requireUser, inflightActorReads, invalidateReadsAroundMutation,
  peekPreviewUserValue, readMockUserValue, writeMockUserValue, readJson, writeJson,
  storage = globalThis.localStorage,
}) {
  const SITE_TRAINING_SCOPE_SET = new Set(['page', 'overall']);
  const SITE_TRAINING_CLAIM_ACTION_SET = new Set(['start', 'resume']);
  const SITE_TRAINING_TRANSITION_ACTION_SET = new Set(['restart', 'back', 'next', 'stop', 'finish']);
  const SITE_TRAINING_REQUEST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const requireCapturedSiteTrainingActor = (expectedUserId) => {
    const actorId = String(expectedUserId || '').trim();
    if (!actorId) {
      throw new TypeError('A captured signed-in account is required for page training operations.');
    }
    return actorId;
  };

  function requireSiteTrainingPage(page) {
    if (!page?.id
      || !page?.route
      || !Number.isInteger(page.contentVersion)
      || page.contentVersion < 1
      || !Array.isArray(page.steps)
      || !page.steps.length
      || page.steps.some((step) => !step?.id)) {
      throw new TypeError('A published page training contract is required.');
    }
    return page;
  }

  function requireSiteTrainingProgram(program, scope) {
    if (scope === 'page' && !program) return null;
    if (!program?.id
      || !Number.isInteger(program.version)
      || program.version < 1
      || !Array.isArray(program.pages)
      || !program.pages.length) {
      throw new TypeError('A published site training program is required for overall progress.');
    }
    return program;
  }

  function requireSiteTrainingOperation({
    page,
    program = null,
    scope = 'page',
    action,
    requestId,
    expectedRevision,
    expectedPageRevision,
  }) {
    const normalizedScope = String(scope || '').trim().toLowerCase();
    if (!SITE_TRAINING_SCOPE_SET.has(normalizedScope)) throw new TypeError('Choose page or overall training progress.');
    const resolvedExpectedPageRevision = expectedPageRevision === undefined
      && normalizedScope === 'page'
      ? expectedRevision
      : expectedPageRevision;
    const normalizedAction = String(action || '').trim().toLowerCase();
    if (!SITE_TRAINING_REQUEST_PATTERN.test(String(requestId || ''))) {
      throw new TypeError('A fresh page training request ID is required.');
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('A current page training revision is required.');
    }
    if (!Number.isInteger(resolvedExpectedPageRevision) || resolvedExpectedPageRevision < 0) {
      throw new TypeError('A current page training revision is required.');
    }
    return {
      page: requireSiteTrainingPage(page),
      program: requireSiteTrainingProgram(program, normalizedScope),
      scope: normalizedScope,
      action: normalizedAction,
      requestId,
      expectedRevision,
      expectedPageRevision: resolvedExpectedPageRevision,
    };
  }

  const mockSiteTrainingPageKey = (page) => `${page.id}:${page.contentVersion}`;
  const mockSiteTrainingProgramKey = (program) => `${program.id}:${program.version}`;

  function withMockSiteTrainingAttemptParity(pageState) {
    if (!pageState || typeof pageState !== 'object' || Array.isArray(pageState)
      || Object.prototype.hasOwnProperty.call(pageState, 'attemptNumber')
      || Object.prototype.hasOwnProperty.call(pageState, 'attempt_number')) return pageState;
    return {
      ...pageState,
      attemptNumber: pageState.status === 'not_started' ? 0 : 1,
    };
  }

  function readMockSiteTrainingStore(actorId, { readOnly = false } = {}) {
    const stored = readOnly
      ? peekPreviewUserValue(storage, actorId, MOCK_SITE_TRAINING_PROGRESS_KEY, {})
      : readMockUserValue(MOCK_SITE_TRAINING_PROGRESS_KEY, {}, actorId);
    return {
      pages: stored?.pages && typeof stored.pages === 'object' && !Array.isArray(stored.pages)
        ? { ...stored.pages }
        : {},
      programs: stored?.programs && typeof stored.programs === 'object' && !Array.isArray(stored.programs)
        ? { ...stored.programs }
        : {},
    };
  }

  function createMockSiteTrainingOverall(program) {
    const firstPage = program.pages[0];
    return {
      programId: program.id,
      programVersion: program.version,
      status: 'not_started',
      currentPageId: firstPage.pageId,
      currentPageContentVersion: firstPage.contentVersion,
      currentPageIndex: 0,
      revision: 0,
      startedAt: null,
      stoppedAt: null,
      completedAt: null,
      updatedAt: null,
    };
  }

  function mockSiteTrainingSnapshot(page, program, actorId, store) {
    const pageKey = mockSiteTrainingPageKey(page);
    const storedPage = withMockSiteTrainingAttemptParity(store.pages[pageKey]);
    let pageState;
    if (storedPage) {
      pageState = {
        ...createSiteTrainingPageProgress(page, actorId),
        page: storedPage,
      };
    } else {
      const priorStates = Object.values(store.pages)
        .map((candidate) => normalizeSiteTrainingState({
          schemaVersion: 1,
          actorId,
          page: candidate,
          overall: null,
          claimedNow: false,
          transition: null,
        }))
        .filter((candidate) => candidate.contractValid
          && candidate.page.pageId === page.id
          && candidate.page.contentVersion !== page.contentVersion);
      const completionCount = priorStates.reduce(
        (count, candidate) => Math.max(count, candidate.page.completionCount),
        0,
      );
      const previous = priorStates
        .filter((candidate) => ['in_progress', 'stopped'].includes(candidate.page.status))
        .sort((left, right) => (
          Date.parse(right.page.updatedAt) - Date.parse(left.page.updatedAt)
          || right.page.contentVersion - left.page.contentVersion
        ))[0];
      pageState = previous
        ? reconcileSiteTrainingContentVersion(previous, page, actorId)
        : createSiteTrainingPageProgress(page, actorId);
      pageState.page.completionCount = completionCount;
      pageState.page.everCompleted = completionCount > 0;
    }

    return normalizeSiteTrainingState({
      ...pageState,
      actorId,
      overall: program
        ? store.programs[mockSiteTrainingProgramKey(program)] || createMockSiteTrainingOverall(program)
        : null,
      claimedNow: false,
      transition: null,
    }, { expectedPage: page, expectedProgram: program });
  }

  function siteTrainingStaleRevisionError() {
    const error = new Error('Page training changed in another tab. Refresh and try again.');
    error.code = '40001';
    error.details = 'site_training_stale_revision';
    return error;
  }

  function siteTrainingRequestReuseError() {
    const error = new Error('This request ID was already used for another page training operation.');
    error.code = '23505';
    error.details = 'site_training_request_collision';
    return error;
  }

  function siteTrainingTargetStep(state, action) {
    const offset = action === 'back' ? -1 : action === 'next' ? 1 : 0;
    return state.page.stepIds[state.page.currentStepIndex + offset] || null;
  }

  function siteTrainingPageFromProgramReference(reference) {
    if (!reference?.pageId || !reference?.route || !reference?.stepIds?.length) return null;
    return {
      id: reference.pageId,
      route: reference.route,
      contentVersion: reference.contentVersion,
      steps: reference.stepIds.map((id) => ({ id })),
    };
  }

  function siteTrainingExpectedResponsePage(page, program, payload) {
    const responsePage = payload?.page;
    if (!program
      || (responsePage?.pageId === page.id && responsePage?.contentVersion === page.contentVersion)) {
      return page;
    }
    const reference = program.pages.find((candidate) => (
      candidate.pageId === responsePage?.pageId
      && candidate.contentVersion === responsePage?.contentVersion
    ));
    return siteTrainingPageFromProgramReference(reference) || page;
  }

  function normalizeSiteTrainingResult(payload, page, program, operation = null) {
    const result = normalizeSiteTrainingMutation(payload, {
      expectedPage: siteTrainingExpectedResponsePage(page, program, payload),
      expectedProgram: program,
    });
    if (operation && (
      result.transition.action !== operation.action
      || result.transition.scope !== operation.scope
      || (operation.action === 'restart' && (
        result.page.status !== 'in_progress'
        || result.page.currentStepId !== operation.page.steps[0].id
        || result.page.currentStepIndex !== 0
        || result.page.furthestStepIndex !== 0
        || result.page.attemptNumber < 2
        || result.page.revision !== operation.expectedPageRevision + 1
        || result.claimedNow
      ))
    )) {
      const error = new Error('The page training response did not match the requested operation.');
      error.code = 'SITE_TRAINING_CONTRACT_INVALID';
      throw error;
    }
    return result;
  }

  function applyMockOverallSiteTrainingTransition(state, program, action, actorId, store) {
    const now = new Date().toISOString();
    const overall = structuredClone(state.overall);
    const pageReference = program.pages.find((candidate) => (
      candidate.pageId === state.page.pageId
      && candidate.contentVersion === state.page.contentVersion
    ));
    if (!pageReference
      || overall.currentPageId !== state.page.pageId
      || overall.currentPageContentVersion !== state.page.contentVersion) {
      throw new Error('Open the current page in this site training program before continuing.');
    }
    let next = structuredClone(state);
    let pageApplied = false;
    let overallApplied = false;
    let completedPage = null;

    if (action === 'start') {
      if (overall.status === 'not_started') overallApplied = true;
      else if (overall.status !== 'in_progress') {
        throw new Error('Use Resume for stopped training; completed training replays locally.');
      }
      if (state.page.status === 'not_started') {
        next = applySiteTrainingTransition(next, 'start', { now });
        pageApplied = next.transition.applied;
      } else if (state.page.status === 'stopped') {
        next = applySiteTrainingTransition(next, 'resume', { now });
        pageApplied = next.transition.applied;
      }
      if (overallApplied) {
        overall.status = 'in_progress';
        overall.startedAt ||= now;
        overall.stoppedAt = null;
      }
    } else if (action === 'resume') {
      if (overall.status === 'stopped') overallApplied = true;
      else if (overall.status !== 'in_progress') {
        throw new Error('Start overall training before resuming it.');
      }
      if (state.page.status === 'stopped') {
        next = applySiteTrainingTransition(next, 'resume', { now });
        pageApplied = next.transition.applied;
      }
      if (overallApplied) {
        overall.status = 'in_progress';
        overall.stoppedAt = null;
      }
    } else if (action === 'back' || action === 'next') {
      if (overall.status !== 'in_progress' || state.page.status !== 'in_progress') {
        throw new Error('Start or resume overall training before navigating it.');
      }
      next = applySiteTrainingTransition(next, action, {
        targetStepId: siteTrainingTargetStep(state, action),
        now,
      });
      pageApplied = next.transition.applied;
      overallApplied = pageApplied;
    } else if (action === 'stop') {
      if (overall.status === 'not_started') throw new Error('Start overall training before stopping it.');
      if (overall.status === 'completed') throw new Error('Completed training cannot be stopped.');
      if (overall.status === 'in_progress') overallApplied = true;
      if (state.page.status === 'in_progress') {
        next = applySiteTrainingTransition(next, 'stop', { now });
        pageApplied = next.transition.applied;
      }
      if (overallApplied) {
        overall.status = 'stopped';
        overall.stoppedAt = now;
      }
    } else if (action === 'finish') {
      if (overall.status !== 'in_progress'
        || !['in_progress', 'completed'].includes(state.page.status)) {
        throw new Error('Reach the final page training step before finishing.');
      }
      if (state.page.status === 'in_progress') {
        next = applySiteTrainingTransition(next, 'finish', { now });
        pageApplied = next.transition.applied;
      }
      overallApplied = true;
      const pageIndex = program.pages.indexOf(pageReference);
      const followingPage = program.pages[pageIndex + 1] || null;
      if (followingPage) {
        overall.status = 'in_progress';
        overall.currentPageId = followingPage.pageId;
        overall.currentPageContentVersion = followingPage.contentVersion;
        overall.currentPageIndex = pageIndex + 1;
        completedPage = next.page;
        const nextPage = siteTrainingPageFromProgramReference(followingPage);
        const nextSnapshot = nextPage
          ? mockSiteTrainingSnapshot(nextPage, null, actorId, store)
          : null;
        if (!nextSnapshot?.contractValid) {
          throw new Error('The next published site training page could not be verified.');
        }
        next.page = nextSnapshot.page;
      } else {
        overall.status = 'completed';
        overall.completedAt = now;
      }
      next.transition = {
        action,
        applied: true,
        completedPageId: state.page.pageId,
        nextRoute: followingPage?.route || null,
      };
    }

    const applied = overallApplied || pageApplied;
    if (applied) {
      overall.revision += 1;
      overall.updatedAt = now;
    }
    next.overall = overall;
    next.claimedNow = action === 'start' && applied;
    next.transition = {
      ...(next.transition || {}),
      action,
      applied,
    };
    return { state: next, completedPage };
  }

  function runMockSiteTrainingOperation(operation, actorId) {
    inflightActorReads.invalidate('get_site_training_state');
    if (getMockUserId() !== actorId) throw new Error('The signed-in account changed. Try again.');
    const signature = JSON.stringify({
      scope: operation.scope,
      action: operation.action,
      pageId: operation.page.id,
      contentVersion: operation.page.contentVersion,
      programId: operation.program?.id || null,
      programVersion: operation.program?.version || null,
      expectedRevision: operation.expectedRevision,
      expectedPageRevision: operation.expectedPageRevision,
    });
    const storedRequests = readJson(MOCK_SITE_TRAINING_REQUESTS_KEY, {});
    const requests = storedRequests && typeof storedRequests === 'object' && !Array.isArray(storedRequests)
      ? { ...storedRequests }
      : {};
    const prior = requests[operation.requestId];
    if (prior) {
      if (prior.actorId !== actorId || prior.signature !== signature) throw siteTrainingRequestReuseError();
      return normalizeSiteTrainingResult(
        {
          ...prior.result,
          page: withMockSiteTrainingAttemptParity(prior.result?.page),
        },
        operation.page,
        operation.program,
        operation,
      );
    }

    const store = readMockSiteTrainingStore(actorId);
    const current = mockSiteTrainingSnapshot(operation.page, operation.program, actorId, store);
    if (!current.contractValid) {
      const error = new Error('The saved page training state could not be verified. Refresh and try again.');
      error.code = 'SITE_TRAINING_CONTRACT_INVALID';
      throw error;
    }
    const revision = operation.scope === 'overall' ? current.overall.revision : current.page.revision;
    if (revision !== operation.expectedRevision) throw siteTrainingStaleRevisionError();
    if (current.page.revision !== operation.expectedPageRevision) throw siteTrainingStaleRevisionError();

    const transition = operation.scope === 'overall'
      ? applyMockOverallSiteTrainingTransition(
          current,
          operation.program,
          operation.action,
          actorId,
          store,
        )
      : {
          state: applySiteTrainingTransition(current, operation.action, {
            targetStepId: siteTrainingTargetStep(current, operation.action),
          }),
          completedPage: null,
        };
    transition.state.transition.scope = operation.scope;
    const result = normalizeSiteTrainingResult(
      transition.state,
      operation.page,
      operation.program,
      operation,
    );
    store.pages[mockSiteTrainingPageKey(operation.page)] = transition.completedPage || result.page;
    if (result.page.pageId !== operation.page.id
      || result.page.contentVersion !== operation.page.contentVersion) {
      store.pages[`${result.page.pageId}:${result.page.contentVersion}`] = result.page;
    }
    if (operation.scope === 'overall') {
      store.programs[mockSiteTrainingProgramKey(operation.program)] = result.overall;
    }
    writeMockUserValue(MOCK_SITE_TRAINING_PROGRESS_KEY, store, actorId);
    requests[operation.requestId] = { actorId, signature, result };
    writeJson(MOCK_SITE_TRAINING_REQUESTS_KEY, requests);
    return result;
  }

  function siteTrainingRpcParameters({
    page,
    program = null,
    scope = 'page',
    action,
    requestId,
    expectedRevision,
    expectedPageRevision,
  }, actorId) {
    return {
      target_scope: scope,
      target_page_id: page.id,
      target_page_content_version: page.contentVersion,
      target_program_id: program?.id || null,
      target_program_version: program?.version || null,
      target_action: action,
      target_request_id: requestId,
      target_expected_revision: expectedRevision,
      target_expected_page_revision: expectedPageRevision,
      target_expected_actor_id: actorId,
    };
  }

  async function getSiteTrainingState({ page, program = null, expectedUserId } = {}) {
    const actorId = requireCapturedSiteTrainingActor(expectedUserId);
    requireSiteTrainingPage(page);
    if (program) requireSiteTrainingProgram(program, 'overall');
    return inflightActorReads.run({ actorId, query: 'get_site_training_state', version: 1,
      args: [page.id, page.contentVersion, program?.id || null, program?.version || null] }, async () => {
      if (isLocalDemoMode()) {
        await requireHybridPreviewUser(actorId);
        if (getMockUserId() !== actorId) throw new Error('The signed-in account changed. Try again.');
        return mockSiteTrainingSnapshot(
          page,
          program,
          actorId,
          readMockSiteTrainingStore(actorId, { readOnly: true }),
        );
      }

      const client = requireSupabase();
      const user = await requireUser(actorId);
      const { data, error } = await client.rpc('get_site_training_state', {
        target_page_id: page.id,
        target_page_content_version: page.contentVersion,
        target_program_id: program?.id || null,
        target_program_version: program?.version || null,
        target_expected_actor_id: user.id,
      });
      await requireUser(actorId);
      if (error) return siteTrainingReadError(error);
      return normalizeSiteTrainingState(data, { expectedPage: page, expectedProgram: program });
    });
  }

  async function claimSiteTraining({
    page,
    program = null,
    scope = 'page',
    action = 'start',
    requestId = newSiteTrainingRequestId(),
    expectedRevision = 0,
    expectedPageRevision,
    expectedUserId,
  } = {}) {
    const actorId = requireCapturedSiteTrainingActor(expectedUserId);
    const operation = requireSiteTrainingOperation({
      page, program, scope, action, requestId, expectedRevision, expectedPageRevision,
    });
    if (!SITE_TRAINING_CLAIM_ACTION_SET.has(operation.action)) {
      throw new TypeError('Start or resume page training through the claim operation.');
    }
    if (isLocalDemoMode()) {
      await requireHybridPreviewUser(actorId);
      return runMockSiteTrainingOperation(operation, actorId);
    }
    const client = requireSupabase();
    const user = await requireUser(actorId);
    const { data, error } = await invalidateReadsAroundMutation(() => client.rpc(
      'claim_site_training',
      siteTrainingRpcParameters(operation, user.id),
    ), 'get_site_training_state');
    if (error) throw error;
    return normalizeSiteTrainingResult(data, page, operation.program, operation);
  }

  async function transitionSiteTraining({
    page,
    program = null,
    scope = 'page',
    action,
    requestId = newSiteTrainingRequestId(),
    expectedRevision,
    expectedPageRevision,
    expectedUserId,
  } = {}) {
    const actorId = requireCapturedSiteTrainingActor(expectedUserId);
    const operation = requireSiteTrainingOperation({
      page, program, scope, action, requestId, expectedRevision, expectedPageRevision,
    });
    if (!SITE_TRAINING_TRANSITION_ACTION_SET.has(operation.action)) {
      throw new TypeError('Choose Restart, Back, Next, Stop, or Finish for active page training.');
    }
    if (operation.action === 'restart' && operation.scope !== 'page') {
      throw new TypeError('Restart is available only for current page training.');
    }
    if (isLocalDemoMode()) {
      await requireHybridPreviewUser(actorId);
      return runMockSiteTrainingOperation(operation, actorId);
    }
    const client = requireSupabase();
    const user = await requireUser(actorId);
    const { data, error } = await invalidateReadsAroundMutation(() => client.rpc(
      'transition_site_training',
      siteTrainingRpcParameters(operation, user.id),
    ), 'get_site_training_state');
    if (error) throw error;
    return normalizeSiteTrainingResult(data, page, operation.program, operation);
  }
  return Object.freeze({ getSiteTrainingState, claimSiteTraining, transitionSiteTraining });
}
