import { canonicalHtmlRoutePath } from './route-path.mjs';

export const SITE_TRAINING_SCHEMA_VERSION = 1;
export const SITE_TRAINING_CATALOG_VERSION = 3;

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
    id: 'dashboard', route: '/dashboard.html', contentVersion: 3, title: 'Dashboard',
    steps: [
      orientation('Welcome to your Solo walkthrough', 'This walkthrough shows you around Dominion. It won’t change your challenge, dates, sharing, or account data.'),
      step('global-navigation', 'Open any member page', 'Use the menu to reach every signed-in page. During this walkthrough, Next follows the pages in order.', 'global-navigation'),
      step('sharing', 'Review before you share', 'Outside the walkthrough, this button opens a preview before anything is shared. The walkthrough won’t open it or publish anything.', 'global-share', ['can-share-progress'], fallback('Sharing isn’t available yet', 'You can’t share progress in the current challenge state. The walkthrough will never publish for you.')),
      step('app-streak', 'Check your streaks', 'App Streak shows the days you visited, your perfect-day streaks, personal bests, and challenge start date.', 'global-app-streak'),
      step('progress-gauges', 'See today and the full challenge', 'One gauge shows today’s seven actions. The other shows your progress through all 77 days.', 'dashboard-progress'),
      step('daily-standards', 'Complete your seven Daily Actions', 'The scorecard groups today’s Mind, Spirit, and Body actions and shows which ones are complete.', 'dashboard-standards', ['daily-standards-open'], fallback('Daily Actions open on your start date', 'You can finish the walkthrough now. These controls will become available on your scheduled start date.')),
      step('check-in', 'Review before you post', 'After completing at least one action, use Check-In to record the day. The walkthrough won’t post anything.', 'dashboard-check-in', ['daily-standards-open'], fallback('Check-In opens with your Daily Actions', 'You can continue the walkthrough now. Check-In will become available on your scheduled start date.')),
      step('levels-points', 'Track levels and points', 'Levels increase separately from rewards. This card shows your total points and progress toward the next level.', 'dashboard-levels'),
      step('community-entry', 'Find your private group', 'Community contains private groups and leaderboards. Your Private Journal has its own tab. The walkthrough won’t create or join a group.', 'dashboard-community'),
    ],
  },
  {
    id: 'bible-reading', route: '/bible-reading.html', contentVersion: 2, title: 'Bible Reading',
    steps: [
      orientation('Bible Reading', 'This page has today’s reading guidance and an optional link to YouVersion.'),
      step('completion', 'Mark Bible Reading complete', 'Outside the walkthrough, this control marks only today’s Bible Reading action. The walkthrough won’t change it.', 'daily-standard-completion', ['daily-standards-open'], fallback('This control opens on your start date', 'You can continue the walkthrough now. The completion control will open when your challenge begins.')),
      step('reading-guidance', 'Read five to eight chapters', 'Read carefully and carry one truth from the passage into the rest of your day.', 'daily-standard-guidance'),
      step('youversion-resource', 'Open YouVersion if you want', 'Outside the walkthrough, this link opens YouVersion in a new page. The walkthrough won’t follow external links.', 'daily-standard-resource'),
    ],
  },
  {
    id: 'morning-prayer', route: '/morning-prayer.html', contentVersion: 2, title: 'Morning Prayer',
    steps: [
      orientation('Morning Prayer', 'This page gives you a simple way to begin the day in prayer.'),
      step('completion', 'Mark Morning Prayer complete', 'Outside the walkthrough, this control marks only today’s Morning Prayer action. The walkthrough won’t change it.', 'daily-standard-completion', ['daily-standards-open'], fallback('This control opens on your start date', 'You can continue the walkthrough now. The completion control will open when your challenge begins.')),
      step('prayer-guidance', 'Begin before the day gets busy', 'Be still, offer the day to God, and ask for wisdom, courage, and a willing spirit.', 'daily-standard-guidance'),
      step('guided-prayer-resource', 'Use a guided prayer if you want', 'Outside the walkthrough, this link opens an optional prayer resource. The walkthrough won’t open it.', 'daily-standard-resource'),
    ],
  },
  {
    id: 'worship', route: '/worship.html', contentVersion: 2, title: 'Worship',
    steps: [
      orientation('Worship', 'This page has today’s worship prompt and an optional Spotify link.'),
      step('completion', 'Mark Worship complete', 'Outside the walkthrough, this control marks only today’s Worship action. The walkthrough won’t change it.', 'daily-standard-completion', ['daily-standards-open'], fallback('This control opens on your start date', 'You can continue the walkthrough now. The completion control will open when your challenge begins.')),
      step('worship-guidance', 'Listen with your full attention', 'Choose worship music and listen without treating it as background noise.', 'daily-standard-guidance'),
      step('spotify-resource', 'Open Spotify if you want', 'Outside the walkthrough, this link opens today’s worship search in Spotify. The walkthrough won’t open it.', 'daily-standard-resource'),
    ],
  },
  {
    id: 'evening-prayer', route: '/evening-prayer.html', contentVersion: 2, title: 'Evening Prayer',
    steps: [
      orientation('Evening Prayer', 'This page closes the day with reflection, gratitude, confession, and release.'),
      step('completion', 'Mark Evening Prayer complete', 'Outside the walkthrough, this control marks only today’s Evening Prayer action. The walkthrough won’t change it.', 'daily-standard-completion', ['daily-standards-open'], fallback('This control opens on your start date', 'You can continue the walkthrough now. The completion control will open when your challenge begins.')),
      step('reflection-guidance', 'Review the day honestly', 'Give thanks, receive grace, consider what you learned, and entrust tomorrow to God.', 'daily-standard-guidance'),
      step('guided-prayer-resource', 'Use a guided prayer if you want', 'Outside the walkthrough, this link opens an optional prayer resource. The walkthrough won’t open it.', 'daily-standard-resource'),
    ],
  },
  ...[
    ['workout-one', '/workout-one.html', 'Workout #1', 'Build the first movement session with a recommendation that can match your chosen difficulty.'],
    ['workout-two', '/workout-two.html', 'Workout #2', 'Finish the second movement session with a recommendation that can match your chosen difficulty.'],
  ].map(([id, route, title, intro]) => ({
    id, route, contentVersion: 2, title,
    steps: [
      orientation(title, intro),
      step('completion', `Mark ${title} complete`, `Outside the walkthrough, this control marks only today’s ${title} action. The walkthrough won’t change it.`, 'daily-standard-completion', ['daily-standards-open'], fallback('This control opens on your start date', 'You can continue the walkthrough now. The completion control will open when your challenge begins.')),
      step('recommendation', 'See today’s workout', 'Choose a difficulty to adjust the workout. Every difficulty is still worth one point.', 'daily-standard-guidance'),
      step('difficulty', 'Choose a difficulty', 'Outside the walkthrough, this menu changes the workout recommendation but not its point value.', 'daily-standard-difficulty', ['daily-standards-open'], fallback('Difficulty opens with this Daily Action', 'You can review the workout now. The difficulty menu will open when your challenge begins.')),
      step('native-health', 'Apple Fitness is optional', 'You can open Apple Fitness as a separate resource. This web app doesn’t request HealthKit data.', 'daily-standard-native'),
    ],
  })),
  {
    id: 'intentional-walk', route: '/intentional-walk.html', contentVersion: 2, title: 'Intentional Walk',
    steps: [
      orientation('Intentional Walk', 'This page helps you step away from the screen and take a focused walk during the day.'),
      step('completion', 'Mark Intentional Walk complete', 'Outside the walkthrough, this control marks only today’s Intentional Walk action. The walkthrough won’t change it.', 'daily-standard-completion', ['daily-standards-open'], fallback('This control opens on your start date', 'You can continue the walkthrough now. The completion control will open when your challenge begins.')),
      step('walk-guidance', 'Leave the screen behind', 'Walk at a pace you can sustain, pay attention to your surroundings, and return with one clear priority.', 'daily-standard-guidance'),
      step('alarm-and-steps', 'Alarm and step tools are optional', 'The web app can explain these tools, but it can’t create an alarm, read steps, or connect a health provider.', 'daily-standard-native'),
    ],
  },
  {
    id: 'badges-rewards', route: '/badges-rewards.html', contentVersion: 2, title: 'Badges & Rewards',
    steps: [
      orientation('Badges & Rewards', 'Rewards are based on points. Badges recognize specific challenge milestones.'),
      step('tabs', 'Switch between rewards and badges', 'Use these tabs to see point rewards or the badges you’ve earned.', 'rewards-tabs'),
      step('next-unlock', 'See your next reward', 'This card shows the next point goal and how close you are to reaching it.', 'rewards-next-unlock'),
      step('reward-catalog', 'Review every reward', 'The list shows how many points each reward requires. The walkthrough won’t earn or start anything.', 'rewards-catalog'),
      step('badges', 'Review your badges', 'The Badges tab shows milestones you earned through challenge activity.', 'rewards-badges'),
      step('sharing', 'Review before you share', 'Outside the walkthrough, the composer shows a preview before you share. The walkthrough won’t open it or publish anything.', 'rewards-sharing', ['can-share-progress'], fallback('Sharing isn’t available yet', 'Your rewards and badges stay private until sharing is available and you choose to use it.')),
    ],
  },
  {
    id: 'community', route: '/community.html', contentVersion: 3, title: 'Community',
    steps: [
      orientation('Community', 'Community is where you create or join a private group. Your Private Journal remains a separate page. The walkthrough won’t create, join, invite, connect, or save anything.'),
      step('tabs', 'Open any main member page', 'Dashboard, Rewards, Community, and Private Journal are always available from these tabs.', 'community-tabs'),
      step('create-or-join', 'Create or join a group', 'This area shows your current group or lets you create or join one. The walkthrough won’t submit either form.', 'community-create-or-join'),
      step('roles-and-roster', 'See members and roles', 'Owners, admins, and members see only the controls allowed for their role.', 'community-roster', ['has-active-crew'], fallback('Member controls appear after you join a group', 'You aren’t viewing an active group right now. Roles and member controls will appear after you join one.')),
      step('leaderboard', 'Compare group progress', 'Switch between weekly and full-challenge results for members of this private group.', 'community-leaderboard'),
      step('integrations', 'Control external updates in Group Settings', 'Slack and Discord require an eligible group, a connected channel, and each member’s consent. The walkthrough won’t connect anything.', 'community-integrations', ['group-integrations-enabled', 'crew-integration-authorized'], fallback('External updates aren’t available', 'Slack and Discord controls appear only for eligible groups and roles. The walkthrough won’t enable or connect them.')),
      step('private-journal', 'Your journal stays private', 'Private Journal has its own tab for personal notes and reflections. The walkthrough won’t read, reveal, or save an entry.', 'community-private-journal'),
    ],
  },
  {
    id: 'private-journal', route: '/private-journal.html', contentVersion: 2, title: 'Private Journal',
    steps: [
      orientation('Private Journal', 'Use this page for notes and reflections you don’t want to share with your group. The walkthrough won’t read, change, or save an entry.'),
      step('navigation', 'Open any main member page', 'Dashboard, Rewards, Community, and Private Journal are always available from these tabs.', 'private-journal-navigation'),
      step('entry', 'Write a private entry', 'Choose a date and add any mood, energy, notes, wins, or prayer you want to remember. Nothing is saved until you submit the form outside the walkthrough.', 'private-journal-entry'),
      step('timeline', 'Review your entries', 'Your saved entries appear here by date. The walkthrough won’t open, edit, or reveal one.', 'private-journal-timeline'),
    ],
  },
  {
    id: 'profile', route: '/profile.html', contentVersion: 3, title: 'Profile',
    steps: [
      orientation('Profile', 'Use Profile to update your account, check challenge and access status, and choose an app theme.'),
      step('account', 'Update your account', 'Outside the walkthrough, you can change your name, email, and profile picture here. The walkthrough won’t edit or upload anything.', 'profile-account'),
      step('challenge-status', 'Check your challenge status', 'This card shows your current challenge and participation status without changing either one.', 'profile-challenge-status'),
      step('billing', 'Review access', 'Use this section to check account access. When billing is open, its link also opens subscription controls.', 'profile-billing'),
      step('themes', 'Choose an available theme', 'Dark and Light are available now. Themes you earn will appear here too. The walkthrough won’t change your selection.', 'profile-themes', ['themes-available'], fallback('Theme controls aren’t available', 'Your theme won’t change while Dominion checks which options are available.')),
    ],
  },
  {
    id: 'billing', route: '/billing.html', contentVersion: 2, title: 'Billing',
    steps: [
      orientation('Billing', 'This page shows your access status. When billing is open, it also contains subscription and payment controls.'),
      step('membership-access', 'Check your membership', 'This card shows whether your account can use member features.', 'billing-membership-access'),
      step('billing-management', 'Manage your membership', 'When billing is open, these buttons can open Stripe outside the walkthrough. The walkthrough won’t purchase, cancel, or change payment details.', 'billing-management', ['billing-management-available'], fallback('No billing action is available', 'There’s nothing to manage for this account right now. The walkthrough won’t start checkout or change your membership.')),
      step('membership-includes', 'See what’s included', 'Membership includes challenge tracking, Daily Actions, private groups, journaling, rewards, and more member content.', 'billing-membership-includes'),
    ],
  },
  {
    id: 'science', route: '/science.html', contentVersion: 2, title: 'Science',
    steps: [
      orientation('Why Dominion lasts 77 days', 'This final page explains the research and biblical reasoning behind repeating seven actions for 77 days.'),
      step('repetition', 'Repetition builds habits', 'Clear actions, steady reminders, and visible feedback make it easier to repeat the same behaviors over time.', 'science-repetition'),
      step('scripture', 'Scripture frames discipline as stewardship', 'The biblical foundation connects bodily discipline, spiritual fruit, renewed thinking, and faithfulness.', 'science-scripture'),
      step('standards', 'Each action has a purpose', 'The challenge combines Mind, Spirit, Body, and accountability practices into one daily pattern.', 'science-standards'),
      step('sources', 'Review the sources and limits', 'Sources summarize habit research and scriptural patterns, including the need to adapt wisely for health and life circumstances.', 'science-sources'),
      step('training-complete', 'Your Solo site walkthrough is complete', 'Finish records only walkthrough completion. It does not change challenge entries, membership, journal content, integrations, sharing, or settings.'),
    ],
  },
];

const PROGRAM_PAGES = [
  { pageId: 'dashboard', contentVersion: 3 },
  { pageId: 'bible-reading', contentVersion: 2 },
  { pageId: 'morning-prayer', contentVersion: 2 },
  { pageId: 'worship', contentVersion: 2 },
  { pageId: 'evening-prayer', contentVersion: 2 },
  { pageId: 'workout-one', contentVersion: 2 },
  { pageId: 'intentional-walk', contentVersion: 2 },
  { pageId: 'workout-two', contentVersion: 2 },
  { pageId: 'badges-rewards', contentVersion: 2 },
  { pageId: 'community', contentVersion: 3 },
  { pageId: 'private-journal', contentVersion: 2 },
  { pageId: 'profile', contentVersion: 3 },
  { pageId: 'billing', contentVersion: 2 },
  { pageId: 'science', contentVersion: 2 },
];

export const SITE_TRAINING_REGISTRY = defineSiteTrainingRegistry({
  catalogVersion: SITE_TRAINING_CATALOG_VERSION,
  pages: PAGES,
  programs: [{
    id: 'solo-first-run',
    version: 3,
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
