import { canonicalHtmlRoutePath } from './route-path.mjs';

export const SITE_TRAINING_SCHEMA_VERSION = 1;
export const SITE_TRAINING_CATALOG_VERSION = 2;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const ROUTE_PATTERN = /^\/[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const TARGET_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const AUDIENCE_SET = new Set(['all', 'solo', 'group']);

export const SITE_TRAINING_KNOWN_CAPABILITIES = Object.freeze([
  'billing-management-available',
  'can-share-progress',
  'crew-integration-authorized',
  'daily-standards-open',
  'group-integrations-enabled',
  'has-active-crew',
  'themes-available',
]);

export const SITE_TRAINING_EXCLUDED_ROUTES = Object.freeze([
  '/index.html',
  '/membership.html',
  '/login.html',
  '/register.html',
  '/invite.html',
  '/today-actions.html',
]);

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
    audience: text(program.audience).toLowerCase() || 'all',
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
    if (!AUDIENCE_SET.has(program.audience)) {
      errors.push(`Invalid audience for program ${program.id || '(empty)'}.`);
    }
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

const fallback = (title, description) => ({ title, description });
const step = (id, title, description, target = null, capabilities = [], unavailable = null) => ({
  id,
  title,
  description,
  target,
  capabilities,
  unavailable: unavailable || fallback(title, description),
});
const orientation = (title, description) => step('orientation', title, description);

const PAGES = [
  {
    id: 'dashboard', route: '/dashboard.html', contentVersion: 2, title: 'Dashboard',
    steps: [
      orientation('Welcome to your Solo walkthrough', 'This walkthrough explains Dominion without changing challenge entries, dates, sharing, or any other product data.'),
      step('global-navigation', 'Move through Dominion', 'The application menu keeps every signed-in destination together. Training navigation follows only the published walkthrough order.', 'global-navigation'),
      step('sharing', 'Share only when you choose', 'Share opens a reviewable composer outside training. This walkthrough never opens it or publishes progress.', 'global-share', ['can-share-progress'], fallback('Sharing stays under your control', 'Progress sharing is unavailable in the current challenge state. Training will never publish on your behalf.')),
      step('app-streak', 'See consistency at a glance', 'App Streak shows visits, full-standard streaks, personal bests, and the challenge start date without changing them.', 'global-app-streak'),
      step('progress-gauges', 'Read today and the full challenge', 'These gauges separate today’s seven standards from progress across all 77 days.', 'dashboard-progress'),
      step('daily-standards', 'Your seven Daily Standards', 'The scorecard links Spirit, Mind, and Body practices and reflects today’s completion state.', 'dashboard-standards', ['daily-standards-open'], fallback('Your standards unlock on schedule', 'You can learn the full site now. Daily Standard controls become available when your scheduled Solo start date arrives.')),
      step('check-in', 'Post only after review', 'Check-In records the day only when you deliberately use the product control outside training. This walkthrough never posts it.', 'dashboard-check-in', ['daily-standards-open'], fallback('Check-In unlocks with today’s standards', 'Your scheduled challenge can be trained now; Check-In remains unavailable until its date arrives.')),
      step('levels-points', 'Levels and points show momentum', 'Levels rise independently from point-unlocked rewards, while this card shows your current total and progress toward the next level.', 'dashboard-levels'),
      step('community-entry', 'Accountability has its own space', 'Community leads to private groups, leaderboards, and integrations, while Private Journal stays one top-level destination away. Training does not open, create, or join anything.', 'dashboard-community'),
    ],
  },
  {
    id: 'bible-reading', route: '/bible-reading.html', contentVersion: 1, title: 'Bible Reading',
    steps: [
      orientation('Bible Reading', 'This page brings today’s reading standard, guidance, and optional external Bible resource together.'),
      step('completion', 'Today’s completion control', 'Outside training, this control marks only Bible Reading for today. Training never changes it.', 'daily-standard-completion', ['daily-standards-open'], fallback('Completion unlocks on your start date', 'Training is available now; today’s completion control remains locked until the scheduled challenge begins.')),
      step('reading-guidance', 'Read with attention', 'The guidance recommends five to eight chapters and carrying one truth into the day.', 'daily-standard-guidance'),
      step('youversion-resource', 'Optional YouVersion handoff', 'This link can open YouVersion outside Dominion when you choose it outside training. Training never follows external links.', 'daily-standard-resource'),
    ],
  },
  {
    id: 'morning-prayer', route: '/morning-prayer.html', contentVersion: 1, title: 'Morning Prayer',
    steps: [
      orientation('Morning Prayer', 'This page keeps the morning prayer standard and a simple opening practice together.'),
      step('completion', 'Today’s completion control', 'Outside training, this control marks only Morning Prayer for today. Training never changes it.', 'daily-standard-completion', ['daily-standards-open'], fallback('Completion unlocks on your start date', 'Training is available now; today’s completion control remains locked until the scheduled challenge begins.')),
      step('prayer-guidance', 'Begin before the noise', 'The practice centers stillness, surrender, wisdom, courage, and a willing spirit.', 'daily-standard-guidance'),
      step('guided-prayer-resource', 'Optional guided prayer', 'This external resource is available when you choose it outside training. Training never opens it.', 'daily-standard-resource'),
    ],
  },
  {
    id: 'worship', route: '/worship.html', contentVersion: 1, title: 'Worship',
    steps: [
      orientation('Worship', 'This page keeps today’s worship standard and listening prompt in one place.'),
      step('completion', 'Today’s completion control', 'Outside training, this control marks only Worship for today. Training never changes it.', 'daily-standard-completion', ['daily-standards-open'], fallback('Completion unlocks on your start date', 'Training is available now; today’s completion control remains locked until the scheduled challenge begins.')),
      step('worship-guidance', 'Listen with full attention', 'The prompt keeps the standard centered on worship rather than background multitasking.', 'daily-standard-guidance'),
      step('spotify-resource', 'Optional Spotify handoff', 'The daily playlist can open Spotify outside Dominion when you choose it outside training. Training never opens it.', 'daily-standard-resource'),
    ],
  },
  {
    id: 'evening-prayer', route: '/evening-prayer.html', contentVersion: 1, title: 'Evening Prayer',
    steps: [
      orientation('Evening Prayer', 'This page closes the day with reflection, gratitude, confession, and release.'),
      step('completion', 'Today’s completion control', 'Outside training, this control marks only Evening Prayer for today. Training never changes it.', 'daily-standard-completion', ['daily-standards-open'], fallback('Completion unlocks on your start date', 'Training is available now; today’s completion control remains locked until the scheduled challenge begins.')),
      step('reflection-guidance', 'Review the day honestly', 'The prompts help you notice gifts, receive grace, reflect, and entrust tomorrow to God.', 'daily-standard-guidance'),
      step('guided-prayer-resource', 'Optional guided prayer', 'This external resource is available when you choose it outside training. Training never opens it.', 'daily-standard-resource'),
    ],
  },
  ...[
    ['workout-one', '/workout-one.html', 'Workout #1', 'Build the first movement session with a recommendation that can match your chosen difficulty.'],
    ['workout-two', '/workout-two.html', 'Workout #2', 'Finish the second movement session with a recommendation that can match your chosen difficulty.'],
  ].map(([id, route, title, intro]) => ({
    id, route, contentVersion: 1, title,
    steps: [
      orientation(title, intro),
      step('completion', 'Today’s completion control', `Outside training, this control marks only ${title} for today. Training never changes it.`, 'daily-standard-completion', ['daily-standards-open'], fallback('Completion unlocks on your start date', 'Training is available now; today’s completion control remains locked until the scheduled challenge begins.')),
      step('recommendation', 'Today’s workout recommendation', 'The recommendation changes with the selected difficulty while the standard remains worth the same point.', 'daily-standard-guidance'),
      step('difficulty', 'Difficulty is context, not extra credit', 'Outside training, Difficulty adjusts the recommendation without changing the point value. Training never changes the selection.', 'daily-standard-difficulty', ['daily-standards-open'], fallback('Difficulty unlocks with the daily standard', 'The recommendation can be reviewed now; its selector remains locked until the scheduled challenge begins.')),
      step('native-health', 'Native health is optional', 'Apple Fitness can open as a resource. HealthKit connections require a native app, and this web walkthrough never requests health data.', 'daily-standard-native'),
    ],
  })),
  {
    id: 'intentional-walk', route: '/intentional-walk.html', contentVersion: 1, title: 'Intentional Walk',
    steps: [
      orientation('Intentional Walk', 'This page frames the workday walk as an intentional reset rather than another screen task.'),
      step('completion', 'Today’s completion control', 'Outside training, this control marks only Intentional Walk for today. Training never changes it.', 'daily-standard-completion', ['daily-standards-open'], fallback('Completion unlocks on your start date', 'Training is available now; today’s completion control remains locked until the scheduled challenge begins.')),
      step('walk-guidance', 'Leave the screen behind', 'The guidance emphasizes presence, a sustainable pace, and returning with one clear priority.', 'daily-standard-guidance'),
      step('alarm-and-steps', 'Alarm and steps stay optional', 'Native alarm and step integrations are informational in the web app. Training never creates alarms, requests step data, or connects a provider.', 'daily-standard-native'),
    ],
  },
  {
    id: 'badges-rewards', route: '/badges-rewards.html', contentVersion: 1, title: 'Badges & Rewards',
    steps: [
      orientation('Badges & Rewards', 'Rewards and badges are separate views of progress: points unlock rewards, while badges recognize specific milestones.'),
      step('tabs', 'Rewards and badges have separate tabs', 'The tabs keep unlockable rewards and earned badges distinct without changing either.', 'rewards-tabs'),
      step('next-unlock', 'See the next attainable reward', 'This card shows the point target ahead and progress toward it.', 'rewards-next-unlock'),
      step('reward-catalog', 'Review every point reward', 'The catalog shows locked and unlocked paths by their point requirements; training never unlocks or purchases anything.', 'rewards-catalog'),
      step('badges', 'Badges record earned milestones', 'The Badges tab contains milestone proof earned through challenge activity, independent of training.', 'rewards-badges'),
      step('sharing', 'Share after reviewing', 'The progress composer remains under your control outside training. This walkthrough never opens or publishes it.', 'rewards-sharing', ['can-share-progress'], fallback('Sharing is currently unavailable', 'Your rewards and badges remain private until progress sharing is available and you explicitly choose it.')),
    ],
  },
  {
    id: 'community', route: '/community.html', contentVersion: 2, title: 'Community',
    steps: [
      orientation('Community', 'Community contains private-group accountability, with Private Journal available as its own top-level destination. This walkthrough never creates, joins, invites, connects, or saves content.'),
      step('tabs', 'Your core destinations stay in reach', 'Dashboard, Rewards, Community, and Private Journal remain available from this shared navigation.', 'community-tabs'),
      step('create-or-join', 'Create or join only by explicit choice', 'This area reflects whether you can create a crew or manage an existing one. Training never submits either flow.', 'community-create-or-join'),
      step('roles-and-roster', 'Roles protect group controls', 'Owners, admins, and members see only the roster and controls allowed for their role.', 'community-roster', ['has-active-crew'], fallback('Roster controls appear with a crew', 'You are not currently viewing an active crew roster. Roles and member controls remain unavailable until a crew exists.')),
      step('leaderboard', 'The leaderboard stays crew-scoped', 'Week and challenge views compare only members of the selected private group.', 'community-leaderboard'),
      step('integrations', 'External updates are safe-off', 'Slack and Discord require eligible group controls, a destination, and each member’s consent. Training never connects a provider.', 'community-integrations', ['group-integrations-enabled', 'crew-integration-authorized'], fallback('Group integrations are informational here', 'Slack and Discord controls stay hidden unless the feature, crew, and role are eligible. Training never enables or connects them.')),
      step('private-journal', 'Your journal stays private', 'Private Journal is a separate top-level destination for personal notes and reflections. Training never reads, reveals, or saves journal content.', 'community-private-journal'),
    ],
  },
  {
    id: 'private-journal', route: '/private-journal.html', contentVersion: 1, title: 'Private Journal',
    steps: [
      orientation('Private Journal', 'Private Journal keeps personal notes and reflections separate from Community. This walkthrough never reads, reveals, changes, or saves journal content.'),
      step('navigation', 'Your core destinations stay in reach', 'Dashboard, Rewards, Community, and Private Journal remain available from this shared navigation.', 'private-journal-navigation'),
      step('entry', 'A private entry stays under your control', 'Date, mood, energy, notes, wins, and prayer or reflection are saved only when you deliberately submit the form outside training.', 'private-journal-entry'),
      step('timeline', 'Your record remains private', 'Saved entries appear in your personal timeline. Training never opens, edits, or exposes an entry.', 'private-journal-timeline'),
    ],
  },
  {
    id: 'profile', route: '/profile.html', contentVersion: 2, title: 'Profile',
    steps: [
      orientation('Profile', 'Profile brings account identity, challenge status, billing access, and appearance together.'),
      step('account', 'Account details remain editable by you', 'The account card manages your name, email, and profile picture outside training. Training never edits or uploads anything.', 'profile-account'),
      step('challenge-status', 'Check your challenge status', 'This card summarizes the current challenge and participation context without changing it.', 'profile-challenge-status'),
      step('billing', 'Billing access has one home', 'This link leads to subscription status and management. Training never opens checkout or changes membership.', 'profile-billing'),
      step('themes', 'Choose an available theme', 'Dark and Light are available; earned themes appear with their unlock status. Training never changes appearance.', 'profile-themes', ['themes-available'], fallback('Theme controls are unavailable', 'Appearance remains unchanged while theme availability is being verified.')),
    ],
  },
  {
    id: 'billing', route: '/billing.html', contentVersion: 1, title: 'Billing',
    steps: [
      orientation('Billing', 'Billing explains membership access and contains the only subscription and payment controls in this walkthrough.'),
      step('membership-access', 'See membership status', 'The access card shows whether the account can open member features.', 'billing-membership-access'),
      step('billing-management', 'Management actions require your choice', 'Visible billing controls may open a provider outside training. This walkthrough never purchases, cancels, or changes payment details.', 'billing-management', ['billing-management-available'], fallback('Billing management depends on account status', 'No eligible management action is currently available. Training never starts checkout or changes membership.')),
      step('membership-includes', 'What membership includes', 'Membership covers challenge tracking, daily standards, private groups, journaling, rewards, and future guided content.', 'billing-membership-includes'),
    ],
  },
  {
    id: 'science', route: '/science.html', contentVersion: 1, title: 'Science',
    steps: [
      orientation('The why behind Dominion', 'This final page explains the behavioral and biblical reasoning behind a 77-day repeated standard.'),
      step('repetition', 'Repetition builds automaticity', 'Consistent cues, clear actions, visible feedback, and identity reinforce the daily rhythm over time.', 'science-repetition'),
      step('scripture', 'Scripture frames discipline as stewardship', 'The biblical foundation connects bodily discipline, spiritual fruit, renewed thinking, and faithfulness.', 'science-scripture'),
      step('standards', 'Each standard has a purpose', 'Mind, Spirit, Body, and accountability practices combine into one repeated pattern.', 'science-standards'),
      step('sources', 'Review the sources and limits', 'Sources summarize habit research and scriptural patterns, including the need to adapt wisely for health and life circumstances.', 'science-sources'),
      step('training-complete', 'Your Solo site walkthrough is complete', 'Finish records only walkthrough completion. It does not change challenge entries, membership, journal content, integrations, sharing, or settings.'),
    ],
  },
];

const PROGRAM_PAGES = [
  { pageId: 'dashboard', contentVersion: 2 },
  { pageId: 'bible-reading', contentVersion: 1 },
  { pageId: 'morning-prayer', contentVersion: 1 },
  { pageId: 'worship', contentVersion: 1 },
  { pageId: 'evening-prayer', contentVersion: 1 },
  { pageId: 'workout-one', contentVersion: 1 },
  { pageId: 'intentional-walk', contentVersion: 1 },
  { pageId: 'workout-two', contentVersion: 1 },
  { pageId: 'badges-rewards', contentVersion: 1 },
  { pageId: 'community', contentVersion: 2 },
  { pageId: 'private-journal', contentVersion: 1 },
  { pageId: 'profile', contentVersion: 2 },
  { pageId: 'billing', contentVersion: 1 },
  { pageId: 'science', contentVersion: 1 },
];

export const SITE_TRAINING_REGISTRY = defineSiteTrainingRegistry({
  catalogVersion: SITE_TRAINING_CATALOG_VERSION,
  pages: PAGES,
  programs: [{
    id: 'solo-first-run',
    version: 2,
    audience: 'solo',
    title: 'Solo first-run site training',
    pages: PROGRAM_PAGES,
  }],
});

export function siteTrainingPageForRoute(registry, pathname = '') {
  const route = canonicalHtmlRoutePath(pathname);
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
    audience: program.audience,
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
