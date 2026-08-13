import {
  clearAuthSession,
  getLocalOrSessionUser,
  subscribeToAuthStateChanges,
} from './api';
import {
  clearThemeEntitlementState,
  hydrateThemeEntitlementState,
} from './theme-entitlement-state';
import { initThemeState } from './theme-state';
import { initThemeAssets } from './theme-assets';
import { createAuthenticatedHeaderActions } from './shared-header-actions.js';
import { shouldShowAuthenticatedHeaderActions } from './shared-header-state.mjs';
import { closeShareComposer } from './share-composer.js';
import {
  SOLO_TRAINING_LAUNCH_EVENT,
  SOLO_TRAINING_LAUNCH_STORAGE_KEY,
  createSoloFirstRunTraining,
} from './solo-first-run-training.mjs';
import { createPageTrainingControls } from './page-training-controls.mjs';

const topbar = document.querySelector('.topbar');
const memberTabs = document.querySelector('[data-member-tabs]');
const TOPBAR_COMPACT_SCROLL_Y = 12;
const TOPBAR_TOP_SCROLL_Y = 2;

let syncTopbarScrollState = null;
let sharedHeaderActions = null;
let currentMenuOwner = '';
let currentTrainingOwner = '';
let menuHydrationRequest = 0;
let globalMenuListenersBound = false;
let soloFirstRunTraining = null;
let pageTrainingControls = null;

const loggedInLinks = [
  ['Dashboard', './dashboard.html'],
  ['Badges & Rewards', './badges-rewards.html'],
  ['Billing', './billing.html'],
  ['Community', './community.html'],
  ['Private Journal', './private-journal.html'],
  ['Check-In', './dashboard.html#check-in'],
  ['Profile', './profile.html'],
];

const publicLinks = [
  ['Home', './index.html'],
  ['Membership', './membership.html'],
  ['Learn Why', './science.html'],
  ['Log In', './login.html'],
];

const MENU_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusWithoutScroll(element) {
  if (!element?.focus) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function trapMenuFocus(event) {
  if (event.key !== 'Tab' || !document.body.classList.contains('menu-open')) return;

  const menu = document.querySelector('.global-menu');
  const focusable = [...(menu?.querySelectorAll(MENU_FOCUSABLE_SELECTOR) || [])]
    .filter((element) => {
      const styles = window.getComputedStyle(element);
      return !element.hidden
        && element.getAttribute('aria-hidden') !== 'true'
        && styles.display !== 'none'
        && styles.visibility !== 'hidden';
    });
  if (!focusable.length) {
    event.preventDefault();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const focusIsOutside = !menu.contains(document.activeElement);

  if (event.shiftKey && (focusIsOutside || document.activeElement === first)) {
    event.preventDefault();
    focusWithoutScroll(last);
  } else if (!event.shiftKey && (focusIsOutside || document.activeElement === last)) {
    event.preventDefault();
    focusWithoutScroll(first);
  }
}

function syncMenuExpandedState(isOpen) {
  const button = document.querySelector('.global-menu-button');
  const menu = document.querySelector('.global-menu');

  button?.setAttribute('aria-expanded', String(isOpen));
  if (!menu) return;

  menu.inert = !isOpen;
  menu.setAttribute('aria-hidden', String(!isOpen));
  if (isOpen) menu.removeAttribute('inert');
  else menu.setAttribute('inert', '');
}

function closeMenu() {
  const wasOpen = document.body.classList.contains('menu-open');
  const button = document.querySelector('.global-menu-button');
  document.body.classList.remove('menu-open');
  syncMenuExpandedState(false);
  syncTopbarScrollState?.();

  if (wasOpen) focusWithoutScroll(button);
}

function destroyTrainingControllers() {
  soloFirstRunTraining?.destroy();
  soloFirstRunTraining = null;
  pageTrainingControls?.destroy();
  pageTrainingControls = null;
  currentTrainingOwner = '';
}

function closeMenuForTraining() {
  closeMenu();
  return document.querySelector('.global-menu-button');
}

function refreshTrainingControllers({ hideWhileLoading = true } = {}) {
  const pageRefresh = pageTrainingControls?.refresh({ hideWhileLoading });
  return Promise.resolve(pageRefresh).then(() => soloFirstRunTraining?.refresh({
    autoOpen: false,
    consumeHandoff: false,
  }));
}

function openMenu() {
  void refreshTrainingControllers();
  document.body.classList.add('menu-open');
  syncMenuExpandedState(true);
  topbar?.classList.remove('topbar-collapsed');
  const menu = document.querySelector('.global-menu');
  const firstVisibleControl = [...(menu?.querySelectorAll(MENU_FOCUSABLE_SELECTOR) || [])]
    .find((element) => {
      const styles = window.getComputedStyle(element);
      return !element.hidden && styles.display !== 'none' && styles.visibility !== 'hidden';
    });
  focusWithoutScroll(firstVisibleControl);
}

function initScrollResponsiveTopbar() {
  if (!topbar) return;

  let ticking = false;

  const update = () => {
    const currentScrollY = Math.max(window.scrollY || 0, 0);
    const menuIsOpen = document.body.classList.contains('menu-open');

    if (menuIsOpen || currentScrollY <= TOPBAR_TOP_SCROLL_Y) {
      topbar.classList.remove('topbar-collapsed');
      memberTabs?.classList.remove('member-tabs-collapsed');
    } else if (currentScrollY > TOPBAR_COMPACT_SCROLL_Y) {
      topbar.classList.add('topbar-collapsed');
      memberTabs?.classList.add('member-tabs-collapsed');
    }

    topbar.classList.toggle('topbar-scrolled', currentScrollY > TOPBAR_TOP_SCROLL_Y);
    memberTabs?.classList.toggle('member-tabs-scrolled', currentScrollY > TOPBAR_TOP_SCROLL_Y);
    ticking = false;
  };

  syncTopbarScrollState = update;

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });

  update();
}

function initTopbarStickyOffset() {
  if (!topbar) return;

  const root = document.documentElement;
  let previousTopbarHeight = 0;
  let previousMemberTabsHeight = -1;

  const syncStickyHeights = () => {
    const topbarHeight = topbar.getBoundingClientRect().height;
    const memberTabsHeight = memberTabs?.getBoundingClientRect().height || 0;
    if (Number.isFinite(topbarHeight) && topbarHeight > 0 && Math.abs(topbarHeight - previousTopbarHeight) >= 0.1) {
      previousTopbarHeight = topbarHeight;
      root.style.setProperty('--topbar-sticky-height', `${topbarHeight.toFixed(2)}px`);
    }

    if (Number.isFinite(memberTabsHeight) && memberTabsHeight >= 0 && Math.abs(memberTabsHeight - previousMemberTabsHeight) >= 0.1) {
      previousMemberTabsHeight = memberTabsHeight;
      root.style.setProperty('--member-tabs-sticky-height', `${memberTabsHeight.toFixed(2)}px`);
    }
  };

  syncStickyHeights();
  window.addEventListener('resize', syncStickyHeights, { passive: true });

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(syncStickyHeights);
    observer.observe(topbar, { box: 'border-box' });
    if (memberTabs) observer.observe(memberTabs, { box: 'border-box' });
  }
}

async function buildMenu() {
  if (!topbar) return;

  const requestId = ++menuHydrationRequest;
  let user = null;
  try {
    user = await getLocalOrSessionUser();
  } catch (error) {
    console.warn('Unable to hydrate the application menu', error);
  }
  if (requestId !== menuHydrationRequest) return;

  const isLoggedIn = Boolean(user?.authenticated);
  const nextOwner = isLoggedIn ? String(user?.userId || user?.email || '') : '';

  let button = document.querySelector('.global-menu-button');
  let overlay = document.querySelector('.global-menu-backdrop');
  let menu = document.querySelector('.global-menu');
  if (menu && typeof menu.querySelector !== 'function') return;

  if (!button) {
    button = document.createElement('button');
    button.className = 'global-menu-button';
    button.type = 'button';
    button.setAttribute('aria-label', 'Open menu');
    button.setAttribute('aria-controls', 'global-menu');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span></span><span></span><span></span>';
    button.addEventListener('click', () => {
      document.body.classList.contains('menu-open') ? closeMenu() : openMenu();
    });
  }

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'global-menu-backdrop';
    overlay.addEventListener('click', closeMenu);
    document.body.appendChild(overlay);
  }

  if (!menu) {
    menu = document.createElement('aside');
    menu.id = 'global-menu';
    menu.className = 'global-menu';
    menu.setAttribute('aria-label', 'Application menu');
    menu.setAttribute('aria-hidden', 'true');
    menu.setAttribute('inert', '');
    menu.inert = true;
    document.body.appendChild(menu);
  }

  menu.id ||= 'global-menu';
  button.setAttribute('aria-controls', menu.id);

  const links = isLoggedIn ? loggedInLinks : publicLinks;
  const profileLabel = isLoggedIn ? (user?.name || 'Member') : 'Visitor';
  const profileSubtext = isLoggedIn ? (user?.email || 'Logged in') : 'Join the 77-day challenge';

  menu.innerHTML = `
    <div class="global-menu-header">
      <div>
        <p class="eyebrow">Dominion</p>
        <h2>${profileLabel}</h2>
        <span>${profileSubtext}</span>
      </div>
      <button class="global-menu-close" type="button" aria-label="Close menu">×</button>
    </div>
    <nav class="global-menu-links" aria-label="Global navigation" data-training-target="global-navigation">
      ${links.map(([label, href]) => `<a href="${href}">${label}</a>`).join('')}
    </nav>
    <nav class="global-menu-policy-links" aria-label="Policies and support">
      <a href="./privacy.html">Privacy</a>
      <a href="./terms.html">Terms</a>
      <a href="./cancellation-refunds.html">Cancellation &amp; Refunds</a>
      <a href="./support.html">Support</a>
    </nav>
    ${isLoggedIn ? `
      <section class="global-menu-training-section" aria-label="Training" hidden>
        <p class="eyebrow">Training</p>
        <div class="global-menu-full-training" aria-label="Full-site Solo training">
          <span>Full-site Solo walkthrough</span>
          <button class="global-menu-training" type="button" hidden>Start Training</button>
        </div>
        <div class="global-menu-page-training" role="group" aria-label="This page" hidden>
          <span>This page</span>
          <button class="global-menu-page-training-primary" type="button" hidden>Start page training</button>
          <button class="global-menu-page-training-restart" type="button" aria-haspopup="dialog" hidden>Restart page training</button>
          <p class="global-menu-page-training-feedback" role="alert" aria-live="assertive" hidden></p>
        </div>
      </section>
    ` : ''}
    ${isLoggedIn ? '<button class="global-menu-logout" type="button">Log Out</button>' : ''}
  `;

  const trailingActions = topbar.querySelector('.topbar-trailing-actions');
  (trailingActions || topbar).appendChild(button);
  syncMenuExpandedState(document.body.classList.contains('menu-open'));
  menu.querySelector('.global-menu-close')?.addEventListener('click', closeMenu);
  menu.querySelector('.global-menu-logout')?.addEventListener('click', async () => {
    closeShareComposer('logout');
    destroyTrainingControllers();
    sharedHeaderActions?.destroy();
    sharedHeaderActions = null;
    currentMenuOwner = '';
    clearThemeEntitlementState();
    await clearAuthSession();
    closeMenu();
    window.location.href = './index.html';
  });

  if (!globalMenuListenersBound) {
    globalMenuListenersBound = true;
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.body.classList.contains('menu-open')) {
        event.preventDefault();
        closeMenu();
      } else {
        trapMenuFocus(event);
      }
    });
  }

  const showMemberActions = shouldShowAuthenticatedHeaderActions({
    user,
    pathname: window.location?.pathname || '',
  });
  if (currentMenuOwner && currentMenuOwner !== nextOwner) closeShareComposer('account-change');
  if (currentTrainingOwner && currentTrainingOwner !== nextOwner) {
    destroyTrainingControllers();
  }

  if (showMemberActions) {
    if (sharedHeaderActions) sharedHeaderActions.setUser(user);
    else sharedHeaderActions = createAuthenticatedHeaderActions({ topbar, user });
  } else if (sharedHeaderActions) {
    closeShareComposer('auth-change');
    sharedHeaderActions.destroy();
    sharedHeaderActions = null;
  }
  if (isLoggedIn && nextOwner) {
    let pageTrainingRefresh = null;
    if (!pageTrainingControls) {
      const nextPageTraining = createPageTrainingControls({
        user,
        beforeOpen: closeMenuForTraining,
      });
      if (nextPageTraining.available) {
        pageTrainingControls = nextPageTraining;
        currentTrainingOwner = nextOwner;
        pageTrainingRefresh = pageTrainingControls.refresh();
      } else {
        nextPageTraining.destroy();
      }
    } else {
      pageTrainingRefresh = pageTrainingControls.refresh({ hideWhileLoading: true });
    }
    if (!soloFirstRunTraining) {
      const nextTraining = createSoloFirstRunTraining({
        user,
        runtime: pageTrainingControls?.runtime || null,
      });
      if (nextTraining.available) {
        soloFirstRunTraining = nextTraining;
        currentTrainingOwner = nextOwner;
        void Promise.resolve(pageTrainingRefresh)
          .then(() => soloFirstRunTraining?.refresh());
      } else {
        nextTraining.destroy();
      }
    } else {
      void Promise.resolve(pageTrainingRefresh).then(() => soloFirstRunTraining?.refresh({
        autoOpen: false,
        consumeHandoff: false,
      }));
    }
    pageTrainingControls?.attachControls({
      section: menu.querySelector('.global-menu-training-section'),
      group: menu.querySelector('.global-menu-page-training'),
      primary: menu.querySelector('.global-menu-page-training-primary'),
      restart: menu.querySelector('.global-menu-page-training-restart'),
      feedback: menu.querySelector('.global-menu-page-training-feedback'),
    });
    soloFirstRunTraining?.attachControl(menu.querySelector('.global-menu-training'));
  } else {
    destroyTrainingControllers();
  }
  currentMenuOwner = nextOwner;
}

initThemeState();
initThemeAssets();
hydrateThemeEntitlementState().then(({ error }) => {
  if (error) console.warn('Unable to verify theme reward ownership', error);
});
initScrollResponsiveTopbar();
initTopbarStickyOffset();
buildMenu();

subscribeToAuthStateChanges(({ event, user }) => {
  const nextOwner = user?.authenticated ? String(user?.userId || user?.email || '') : '';
  const ownerChanged = event === 'SIGNED_OUT' || nextOwner !== currentMenuOwner;
  menuHydrationRequest += 1;
  if (ownerChanged) {
    closeShareComposer('auth-state-change');
    sharedHeaderActions?.destroy();
    sharedHeaderActions = null;
    destroyTrainingControllers();
    currentMenuOwner = '';
    clearThemeEntitlementState();
    closeMenu();
  }

  window.setTimeout(() => {
    void buildMenu();
    if (ownerChanged || event === 'USER_UPDATED') {
      void hydrateThemeEntitlementState().then(({ error }) => {
        if (error) console.warn('Unable to verify theme reward ownership', error);
      });
    }
  }, 0);
});

window.addEventListener('storage', (event) => {
  if (event.key === 'dominion:user') {
    void buildMenu();
    return;
  }
  if (event.key === SOLO_TRAINING_LAUNCH_STORAGE_KEY) {
    void soloFirstRunTraining?.refresh({ autoOpen: false, consumeHandoff: true });
    return;
  }
  if (event.key === 'dominion:siteTrainingProgress') {
    void refreshTrainingControllers();
    return;
  }
  if (event.key === 'dominion:startDate' || event.key === 'dominion:mockChallengeActivation') {
    void pageTrainingControls?.refresh({ invalidateCachedActivation: true });
    void soloFirstRunTraining?.refresh({
      autoOpen: false,
      consumeHandoff: false,
      invalidateCachedActivation: true,
    });
  }
  if ([
    'dominion:gameStats',
    'dominion:startDate',
    'dominion:checkInDates',
    'dominion:previewCheckInDates',
    'dominion:previewChallengeSimulation',
  ].includes(event.key)) void sharedHeaderActions?.refresh({ includeLockState: true });
});

window.addEventListener('dominion:challenge-activation-updated', () => {
  void sharedHeaderActions?.refresh({ includeLockState: true });
  void pageTrainingControls?.refresh({ invalidateCachedActivation: true });
  void soloFirstRunTraining?.refresh({
    autoOpen: false,
    consumeHandoff: true,
    invalidateCachedActivation: true,
  });
});

window.addEventListener('dominion:challenge-start-date-updated', () => {
  void pageTrainingControls?.refresh({ invalidateCachedActivation: true });
  void soloFirstRunTraining?.refresh({
    autoOpen: false,
    consumeHandoff: false,
    invalidateCachedActivation: true,
  });
});

window.addEventListener(SOLO_TRAINING_LAUNCH_EVENT, (event) => {
  void soloFirstRunTraining?.consumeHandoff(event.detail);
});

window.addEventListener('focus', () => {
  void buildMenu();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void buildMenu();
});
