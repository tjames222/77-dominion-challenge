import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';
import {
  EMPTY_SITE_TRAINING_REGISTRY,
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
  test('ships an inert empty foundation until a later ticket publishes content', () => {
    assert.equal(EMPTY_SITE_TRAINING_REGISTRY.pages.length, 0);
    assert.equal(EMPTY_SITE_TRAINING_REGISTRY.programs.length, 0);
    assert.equal(SITE_TRAINING_REGISTRY, EMPTY_SITE_TRAINING_REGISTRY);
    assert.equal(Object.isFrozen(EMPTY_SITE_TRAINING_REGISTRY), true);
    assert.deepEqual(validateSiteTrainingRegistry(SITE_TRAINING_REGISTRY, {
      canonicalRoutes: Object.values(PRODUCTION_ENTRYPOINTS).map((entry) => `/${entry}`),
    }), { valid: true, errors: [] });
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
