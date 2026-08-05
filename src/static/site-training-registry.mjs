export const SITE_TRAINING_SCHEMA_VERSION = 1;
export const SITE_TRAINING_CATALOG_VERSION = 1;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const ROUTE_PATTERN = /^\/[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const TARGET_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const integer = (value) => {
  const number = Number(value);
  return Number.isInteger(number) ? number : 0;
};

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

function normalizedFallback(value, step) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    title: text(source.title) || text(step.title),
    description: text(source.description) || text(step.description),
  };
}

function normalizedStep(step = {}) {
  const capabilities = Array.isArray(step.capabilities)
    ? [...new Set(step.capabilities.map(text).filter(Boolean))]
    : [];
  return {
    id: text(step.id),
    title: text(step.title),
    description: text(step.description),
    target: text(step.target) || null,
    capabilities,
    unavailable: normalizedFallback(step.unavailable, step),
  };
}

function normalizedPage(page = {}) {
  return {
    id: text(page.id),
    route: text(page.route),
    contentVersion: integer(page.contentVersion),
    title: text(page.title),
    steps: Array.isArray(page.steps) ? page.steps.map(normalizedStep) : [],
  };
}

function normalizedProgramPage(page = {}) {
  return {
    pageId: text(page.pageId),
    contentVersion: integer(page.contentVersion),
    route: text(page.route) || null,
    stepIds: Array.isArray(page.stepIds) ? page.stepIds.map(text).filter(Boolean) : [],
  };
}

function normalizedProgram(program = {}) {
  return {
    id: text(program.id),
    version: integer(program.version),
    title: text(program.title),
    pages: Array.isArray(program.pages) ? program.pages.map(normalizedProgramPage) : [],
  };
}

export function validateSiteTrainingRegistry(registry, {
  canonicalRoutes = null,
  knownCapabilities = null,
} = {}) {
  const errors = [];
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    return { valid: false, errors: ['A site training registry object is required.'] };
  }

  if (registry.schemaVersion !== SITE_TRAINING_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SITE_TRAINING_SCHEMA_VERSION}.`);
  }
  if (!Number.isInteger(registry.catalogVersion) || registry.catalogVersion < 1) {
    errors.push('catalogVersion must be a positive integer.');
  }
  if (!Array.isArray(registry.pages)) errors.push('pages must be an array.');
  if (!Array.isArray(registry.programs)) errors.push('programs must be an array.');

  const routes = canonicalRoutes ? new Set(canonicalRoutes) : null;
  const capabilities = knownCapabilities ? new Set(knownCapabilities) : null;
  const pageIds = new Set();
  const pageRoutes = new Set();

  for (const page of Array.isArray(registry.pages) ? registry.pages : []) {
    if (!IDENTIFIER_PATTERN.test(page.id || '')) errors.push(`Invalid page id: ${page.id || '(empty)'}.`);
    else if (pageIds.has(page.id)) errors.push(`Duplicate page id: ${page.id}.`);
    pageIds.add(page.id);

    if (!ROUTE_PATTERN.test(page.route || '')) errors.push(`Invalid route for ${page.id || '(empty)'}.`);
    else if (pageRoutes.has(page.route)) errors.push(`Duplicate page route: ${page.route}.`);
    else if (routes && !routes.has(page.route)) errors.push(`Unknown production route: ${page.route}.`);
    pageRoutes.add(page.route);

    if (!Number.isInteger(page.contentVersion) || page.contentVersion < 1) {
      errors.push(`contentVersion must be positive for ${page.id || '(empty)'}.`);
    }
    if (!text(page.title)) errors.push(`A title is required for ${page.id || '(empty)'}.`);
    if (!Array.isArray(page.steps) || page.steps.length === 0) {
      errors.push(`At least one ordered step is required for ${page.id || '(empty)'}.`);
      continue;
    }

    const stepIds = new Set();
    for (const step of page.steps) {
      if (!IDENTIFIER_PATTERN.test(step.id || '')) errors.push(`Invalid step id on ${page.id}: ${step.id || '(empty)'}.`);
      else if (stepIds.has(step.id)) errors.push(`Duplicate step id on ${page.id}: ${step.id}.`);
      stepIds.add(step.id);
      if (!text(step.title)) errors.push(`A title is required for ${page.id}/${step.id || '(empty)'}.`);
      if (!text(step.description)) errors.push(`A description is required for ${page.id}/${step.id || '(empty)'}.`);
      if (step.target !== null && !TARGET_PATTERN.test(step.target || '')) {
        errors.push(`Invalid target token for ${page.id}/${step.id || '(empty)'}.`);
      }
      if (!text(step.unavailable?.title) || !text(step.unavailable?.description)) {
        errors.push(`An accessible fallback is required for ${page.id}/${step.id || '(empty)'}.`);
      }
      for (const capability of step.capabilities || []) {
        if (!IDENTIFIER_PATTERN.test(capability)) {
          errors.push(`Invalid capability on ${page.id}/${step.id}: ${capability}.`);
        } else if (capabilities && !capabilities.has(capability)) {
          errors.push(`Unknown capability on ${page.id}/${step.id}: ${capability}.`);
        }
      }
    }
  }

  const publishedPages = new Map(
    (Array.isArray(registry.pages) ? registry.pages : [])
      .map((page) => [`${page.id}:${page.contentVersion}`, page]),
  );
  const programContracts = new Set();
  for (const program of Array.isArray(registry.programs) ? registry.programs : []) {
    const contractId = `${program.id}:${program.version}`;
    if (!IDENTIFIER_PATTERN.test(program.id || '')) errors.push(`Invalid program id: ${program.id || '(empty)'}.`);
    if (!Number.isInteger(program.version) || program.version < 1) {
      errors.push(`version must be positive for program ${program.id || '(empty)'}.`);
    }
    if (programContracts.has(contractId)) errors.push(`Duplicate program version: ${contractId}.`);
    programContracts.add(contractId);
    if (!text(program.title)) errors.push(`A title is required for program ${program.id || '(empty)'}.`);
    if (!Array.isArray(program.pages) || program.pages.length === 0) {
      errors.push(`At least one ordered page is required for program ${program.id || '(empty)'}.`);
      continue;
    }
    const programPageIds = new Set();
    const programPages = new Set();
    for (const page of program.pages) {
      const pageContract = `${page.pageId}:${page.contentVersion}`;
      if (!IDENTIFIER_PATTERN.test(page.pageId || '') || page.contentVersion < 1) {
        errors.push(`Invalid page contract in program ${program.id}.`);
      } else if (!publishedPages.has(pageContract)) {
        errors.push(`Unknown page version in program ${program.id}: ${pageContract}.`);
      } else if (page.route && page.route !== publishedPages.get(pageContract).route) {
        errors.push(`Program route does not match published page ${pageContract}.`);
      } else if (page.stepIds?.length && JSON.stringify(page.stepIds) !== JSON.stringify(
        publishedPages.get(pageContract).steps.map((step) => step.id),
      )) {
        errors.push(`Program steps do not match published page ${pageContract}.`);
      }
      if (programPages.has(pageContract)) {
        errors.push(`Duplicate page version in program ${program.id}: ${pageContract}.`);
      }
      if (programPageIds.has(page.pageId)) {
        errors.push(`Duplicate page id in program ${program.id}: ${page.pageId}.`);
      }
      programPageIds.add(page.pageId);
      programPages.add(pageContract);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function defineSiteTrainingRegistry({
  catalogVersion = SITE_TRAINING_CATALOG_VERSION,
  pages = [],
  programs = [],
} = {}) {
  const normalizedPages = pages.map(normalizedPage);
  const routesByPageContract = new Map(
    normalizedPages.map((page) => [`${page.id}:${page.contentVersion}`, page.route]),
  );
  const registry = {
    schemaVersion: SITE_TRAINING_SCHEMA_VERSION,
    catalogVersion: integer(catalogVersion),
    pages: normalizedPages,
    programs: programs.map(normalizedProgram).map((program) => ({
      ...program,
      pages: program.pages.map((page) => ({
        ...page,
        route: routesByPageContract.get(`${page.pageId}:${page.contentVersion}`) || page.route,
        stepIds: normalizedPages.find((candidate) => (
          candidate.id === page.pageId && candidate.contentVersion === page.contentVersion
        ))?.steps.map((step) => step.id) || page.stepIds,
      })),
    })),
  };
  const validation = validateSiteTrainingRegistry(registry);
  if (!validation.valid) throw new TypeError(validation.errors.join(' '));
  return immutable(registry);
}

export const EMPTY_SITE_TRAINING_REGISTRY = defineSiteTrainingRegistry();
// FOU-1442 replaces this inert publication point with the launch catalog.
export const SITE_TRAINING_REGISTRY = EMPTY_SITE_TRAINING_REGISTRY;

export function siteTrainingPageForRoute(registry, pathname = '') {
  const route = `/${String(pathname || '').split(/[?#]/, 1)[0].split('/').filter(Boolean).pop() || 'index.html'}`;
  return registry?.pages?.find((page) => page.route === route) || null;
}

export function siteTrainingPageContract(page) {
  if (!page) return null;
  return {
    pageId: page.id,
    route: page.route,
    contentVersion: page.contentVersion,
    stepIds: page.steps.map((step) => step.id),
  };
}

export function siteTrainingProgramForPage(registry, page) {
  if (!page) return null;
  return registry?.programs?.find((program) => program.pages.some(
    (candidate) => candidate.pageId === page.id && candidate.contentVersion === page.contentVersion,
  )) || null;
}

export function siteTrainingProgramContract(program) {
  if (!program) return null;
  return {
    programId: program.id,
    programVersion: program.version,
    pages: program.pages.map(({ pageId, contentVersion }) => ({ pageId, contentVersion })),
  };
}

export function resolveSiteTrainingStep(step, capabilities = {}) {
  const missingCapabilities = (step?.capabilities || [])
    .filter((capability) => capabilities[capability] !== true);
  const available = missingCapabilities.length === 0;
  return {
    ...step,
    available,
    missingCapabilities,
    title: available ? step.title : step.unavailable.title,
    description: available ? step.description : step.unavailable.description,
    target: available ? step.target : null,
  };
}
