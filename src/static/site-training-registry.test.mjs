import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';
import {
  EMPTY_SITE_TRAINING_REGISTRY,
  SITE_TRAINING_EXCLUDED_ROUTES,
  SITE_TRAINING_KNOWN_CAPABILITIES,
  SITE_TRAINING_REGISTRY,
  defineSiteTrainingRegistry,
  resolveSiteTrainingStep,
  siteTrainingPageContract,
  siteTrainingPageForRoute,
  siteTrainingProgramContract,
  siteTrainingProgramForPage,
  validateSiteTrainingRegistry,
} from './site-training-registry.mjs';

const page = {
  id: 'framework-page',
  route: '/dashboard.html',
  contentVersion: 1,
  title: 'Framework page',
  steps: [{
    id: 'stable-step',
    title: 'Visible title',
    description: 'Visible description.',
    target: 'framework-target',
    capabilities: ['feature-ready'],
    unavailable: {
      title: 'Fallback title',
      description: 'The feature is not currently available, so this lesson remains informational.',
    },
  }],
};

describe('site training registry', () => {
  test('keeps the inert foundation export while publishing the Solo first-run catalog', () => {
    assert.equal(EMPTY_SITE_TRAINING_REGISTRY.pages.length, 0);
    assert.equal(EMPTY_SITE_TRAINING_REGISTRY.programs.length, 0);
    assert.equal(Object.isFrozen(EMPTY_SITE_TRAINING_REGISTRY), true);
    assert.notEqual(SITE_TRAINING_REGISTRY, EMPTY_SITE_TRAINING_REGISTRY);
    assert.deepEqual(validateSiteTrainingRegistry(SITE_TRAINING_REGISTRY, {
      canonicalRoutes: Object.values(PRODUCTION_ENTRYPOINTS).map((entry) => `/${entry}`),
      knownCapabilities: SITE_TRAINING_KNOWN_CAPABILITIES,
    }), { valid: true, errors: [] });
  });

  test('publishes the immutable Solo v1 program in its reviewed 13-page order', () => {
    const [program] = SITE_TRAINING_REGISTRY.programs;
    assert.deepEqual(
      { id: program.id, version: program.version, audience: program.audience },
      { id: 'solo-first-run', version: 1, audience: 'solo' },
    );
    assert.deepEqual(program.pages.map((entry) => entry.pageId), [
      'dashboard',
      'bible-reading',
      'morning-prayer',
      'worship',
      'evening-prayer',
      'workout-one',
      'intentional-walk',
      'workout-two',
      'badges-rewards',
      'community',
      'profile',
      'billing',
      'science',
    ]);
    assert.equal(SITE_TRAINING_REGISTRY.pages.length, 13);
    for (const publishedPage of SITE_TRAINING_REGISTRY.pages) {
      assert.equal(publishedPage.steps[0].id, 'orientation');
      assert.equal(publishedPage.steps[0].target, null);
      assert.equal(Object.isFrozen(publishedPage.steps[0]), true);
    }
    assert.deepEqual(
      SITE_TRAINING_REGISTRY.pages.find((candidate) => candidate.id === 'community')
        .steps.map((candidate) => candidate.id),
      ['orientation', 'tabs', 'create-or-join', 'roles-and-roster', 'leaderboard', 'integrations', 'private-journal'],
    );
  });

  test('excludes public acquisition, auth, secret invite, and retired routes', () => {
    const publishedRoutes = new Set(SITE_TRAINING_REGISTRY.pages.map((entry) => entry.route));
    assert.deepEqual(SITE_TRAINING_EXCLUDED_ROUTES, [
      '/index.html',
      '/membership.html',
      '/login.html',
      '/register.html',
      '/invite.html',
      '/today-actions.html',
    ]);
    SITE_TRAINING_EXCLUDED_ROUTES.forEach((route) => assert.equal(publishedRoutes.has(route), false));
  });

  test('keeps every published selector token on a static or reviewed dynamic surface', () => {
    const sources = [
      'dashboard.html',
      'bible-reading.html',
      'morning-prayer.html',
      'worship.html',
      'evening-prayer.html',
      'workout-one.html',
      'intentional-walk.html',
      'workout-two.html',
      'badges-rewards.html',
      'community.html',
      'profile.html',
      'billing.html',
      'science.html',
      'src/static/menu.js',
      'src/static/shared-header-actions.js',
      'src/static/daily-standard-page.js',
    ].map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')).join('\n');
    const publishedTargets = new Set(SITE_TRAINING_REGISTRY.pages.flatMap((entry) => (
      entry.steps.map((candidate) => candidate.target).filter(Boolean)
    )));
    for (const target of publishedTargets) {
      assert.equal(
        sources.includes(`data-training-target="${target}"`)
          || sources.includes(`dataset.trainingTarget = '${target}'`),
        true,
        `Missing reviewed product target: ${target}`,
      );
    }
  });

  test('normalizes, freezes, resolves, and exports a server catalog contract', () => {
    const registry = defineSiteTrainingRegistry({
      pages: [page],
      programs: [{
        id: 'site-basics',
        version: 1,
        title: 'Site basics',
        pages: [{ pageId: page.id, contentVersion: page.contentVersion }],
      }],
    });
    assert.equal(Object.isFrozen(registry.pages[0].steps[0]), true);
    assert.equal(siteTrainingPageForRoute(registry, '/nested/dashboard.html?training=1'), registry.pages[0]);
    assert.deepEqual(siteTrainingPageContract(registry.pages[0]), {
      pageId: 'framework-page',
      route: '/dashboard.html',
      contentVersion: 1,
      stepIds: ['stable-step'],
    });
    assert.equal(siteTrainingProgramForPage(registry, registry.pages[0]), registry.programs[0]);
    assert.deepEqual(siteTrainingProgramContract(registry.programs[0]), {
      programId: 'site-basics',
      programVersion: 1,
      audience: 'all',
      pages: [{ pageId: 'framework-page', contentVersion: 1 }],
    });
  });

  test('keeps capability-aware steps structurally stable and supplies accessible fallback copy', () => {
    const step = defineSiteTrainingRegistry({ pages: [page] }).pages[0].steps[0];
    assert.deepEqual(resolveSiteTrainingStep(step, { 'feature-ready': true }), {
      ...step,
      available: true,
      missingCapabilities: [],
    });
    assert.deepEqual(resolveSiteTrainingStep(step, {}), {
      ...step,
      available: false,
      missingCapabilities: ['feature-ready'],
      title: 'Fallback title',
      description: 'The feature is not currently available, so this lesson remains informational.',
      target: null,
    });
  });

  test('CI validation rejects route drift, duplicate IDs, missing fallback, and unknown capabilities', () => {
    const invalid = {
      schemaVersion: 1,
      catalogVersion: 1,
      programs: [{
        id: 'site-basics', version: 1, title: 'Site basics',
        pages: [
          { pageId: 'framework-page', contentVersion: 1 },
          { pageId: 'missing-page', contentVersion: 1 },
        ],
      }],
      pages: [{
        ...page,
        route: '/missing.html',
        steps: [
          { ...page.steps[0], unavailable: {}, capabilities: ['unknown-capability'] },
          { ...page.steps[0] },
        ],
      }],
    };
    const result = validateSiteTrainingRegistry(invalid, {
      canonicalRoutes: ['/dashboard.html'],
      knownCapabilities: ['feature-ready'],
    });
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /Unknown production route/);
    assert.match(result.errors.join('\n'), /accessible fallback/);
    assert.match(result.errors.join('\n'), /Unknown capability/);
    assert.match(result.errors.join('\n'), /Duplicate step id/);
    assert.match(result.errors.join('\n'), /Unknown page version/);
  });

  test('rejects one page ID at multiple versions within the same program', () => {
    const secondVersion = {
      ...page,
      route: '/profile.html',
      contentVersion: 2,
    };
    const result = validateSiteTrainingRegistry({
      schemaVersion: 1,
      catalogVersion: 1,
      pages: [page, secondVersion],
      programs: [{
        id: 'site-basics',
        version: 1,
        title: 'Site basics',
        pages: [
          { pageId: page.id, contentVersion: 1 },
          { pageId: page.id, contentVersion: 2 },
        ],
      }],
    });
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /Duplicate page id in program site-basics: framework-page/);
  });
});
