import {
  clearAuthSession,
  getLocalOrSessionUser,
  subscribeToAuthStateChanges,
  getSiteAdminContext,
  getAdminSessionOwner,
  subscribeToAdminInvalidation,
} from './api';
import {
  clearThemeEntitlementState,
  hydrateThemeEntitlementState,
} from './theme-entitlement-state';
import { initThemeState } from './theme-state';
import { initThemeAssets } from './theme-assets';
import { createAuthenticatedHeaderActions } from './shared-header-actions.js';
import { shouldShowAuthenticatedHeaderActions } from './shared-header-state.mjs';
import { closeShareComposer } from './share-composer-loader.js';
import {
  SOLO_TRAINING_LAUNCH_EVENT,
  SOLO_TRAINING_LAUNCH_STORAGE_KEY,
} from './challenge-start-flow.mjs';
import { hasSiteTrainingRoute } from './site-training-contract.mjs';
import { loadMenuTrainingControllers } from './menu-training-loader.mjs';
import { createSiteTrainingLoadRecovery, TRAINING_RELOAD_LABEL, TRAINING_RELOAD_MESSAGE } from './site-training-load-recovery.mjs';
import { RELEASE_GATES } from './release-gates.mjs';

const topbar = document.querySelector('.topbar');
const memberTabs = document.querySelector('[data-member-tabs]');
const secondaryTabs = document.querySelector('[data-sticky-secondary-tabs]');
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
let trainingLoadRecovery = null;
let menuButtonPlaceholder = null;
let menuBackgroundObserver = null;
const menuBackgroundState = new Map();
let adminMenuRequest = 0;
function removeAdminMenuItem() {
  adminMenuRequest += 1;
  document.querySelector('[data-admin-menu-item]')?.remove();
}
async function refreshAdminMenuItem() {
  removeAdminMenuItem();
  const request = adminMenuRequest; const hydration = menuHydrationRequest;
  try {
    // The shared menu must obey the existing login/MFA presentation gate before
    // making even a readiness RPC. The direct Admin route handles its own
    // explicit AAL1 readiness/challenge screen separately.
    const user = await getLocalOrSessionUser();
    if (request !== adminMenuRequest || hydration !== menuHydrationRequest || !user?.authenticated || !user.userId) return;
    const owner = await getAdminSessionOwner();
    if (request !== adminMenuRequest || hydration !== menuHydrationRequest || owner.actorId !== user.userId) return;
    const context = await getSiteAdminContext({ expectedUserId: owner.actorId });
    if (request !== adminMenuRequest || hydration !== menuHydrationRequest || !context.adminReady
      || !context.permissions.some((permission) => ['users.read', 'audit.read'].includes(permission))) return;
    const nav = document.querySelector('.global-menu nav'); if (!nav) return;
    const link = document.createElement('a'); link.href = './admin.html';
    link.textContent = context.preview ? 'Admin (preview)' : 'Admin'; link.dataset.adminMenuItem = '';
    link.addEventListener('click', closeMenu); nav.append(link);
  } catch { if (request === adminMenuRequest) removeAdminMenuItem(); }
}
subscribeToAdminInvalidation(removeAdminMenuItem);
window.addEventListener('pagehide', removeAdminMenuItem);

const loggedInLinks = [
  ['Dashboard', './dashboard.html'],
  ['Badges & Rewards', './badges-rewards.html'],
  [RELEASE_GATES.billingEnabled ? 'Billing' : 'Early Access', './billing.html'],
  ['Community', './community.html'],
  ['Private Journal', './private-journal.html'],
  ['Check-In', './dashboard.html#check-in'],
  ['Profile', './profile.html'],
];

const publicLinks = [
  ['Home', './index.html'],
  [RELEASE_GATES.billingEnabled ? 'Membership' : 'Early Access', './membership.html'],
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
  const button = document.querySelector('.global-menu-button');
  const focusable = [...(menu?.querySelectorAll(MENU_FOCUSABLE_SELECTOR) || []), button]
    .filter((element) => {
      if (!element) return false;
      const styles = window.getComputedStyle(element);
      return !element.hidden
        && element.getAttribute('aria-hidden') !== 'true'
        && styles.display !== 'none'
        && styles.visibility !== 'hidden'
        && element.getClientRects().length > 0;
    });
  if (!focusable.length) {
    event.preventDefault();
    return;
  }

  // Explicit cycling also includes buttons when Safari's native Tab preference
  // skips them. The lifted close toggle belongs to this same focus sequence.
  const activeIndex = focusable.indexOf(document.activeElement);
  const nextIndex = activeIndex < 0
    ? (event.shiftKey ? focusable.length - 1 : 0)
    : (activeIndex + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
  const next = focusable[nextIndex];
  event.preventDefault();
  focusWithoutScroll(next);
  if (menu.contains(next)) {
    const controlBox = next.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    if (controlBox.top < menuBox.top) menu.scrollTop -= menuBox.top - controlBox.top + 8;
    else if (controlBox.bottom > menuBox.bottom) menu.scrollTop += controlBox.bottom - menuBox.bottom + 8;
  }
}

function isolateMenuBackground() {
  for (const element of document.body.children) {
    if (element.matches('.global-menu, .global-menu-backdrop, .global-menu-button, script, style, link')) continue;
    if (!menuBackgroundState.has(element)) {
      menuBackgroundState.set(element, {
        inert: element.getAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden'),
      });
    }
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  }
}

function restoreMenuBackground() {
  menuBackgroundObserver?.disconnect();
  menuBackgroundObserver = null;
  for (const [element, state] of menuBackgroundState) {
    for (const [attribute, value] of [['inert', state.inert], ['aria-hidden', state.ariaHidden]]) {
      if (value === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, value);
    }
  }
  menuBackgroundState.clear();
}

function liftMenuButton(button) {
  if (!button || menuButtonPlaceholder) return;
  const styles = window.getComputedStyle(button);
  menuButtonPlaceholder = document.createElement('span');
  menuButtonPlaceholder.className = 'global-menu-button-placeholder';
  menuButtonPlaceholder.setAttribute('aria-hidden', 'true');
  for (const property of ['width', 'height', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft']) {
    menuButtonPlaceholder.style[property] = styles[property];
  }
  button.replaceWith(menuButtonPlaceholder);
  document.body.appendChild(button);
}

function syncMenuExpandedState(isOpen) {
  const button = document.querySelector('.global-menu-button');
  const menu = document.querySelector('.global-menu');

  button?.setAttribute('aria-expanded', String(isOpen));
  button?.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
  if (memberTabs) {
    memberTabs.inert = isOpen;
    memberTabs.setAttribute?.('aria-hidden', String(isOpen));
    if (isOpen) memberTabs.setAttribute?.('inert', '');
    else memberTabs.removeAttribute?.('inert');
  }
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
  document.documentElement.classList.remove('menu-scroll-locked', 'menu-scroll-gutter');
  restoreMenuBackground();
  if (menuButtonPlaceholder && button) menuButtonPlaceholder.replaceWith(button);
  menuButtonPlaceholder = null;
  syncMenuExpandedState(false);
  syncTopbarScrollState?.();

  if (wasOpen) focusWithoutScroll(button);
}

function destroyTrainingControllers() {
  trainingLoadRecovery?.destroy();
  trainingLoadRecovery = null;
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
  liftMenuButton(document.querySelector('.global-menu-button'));
  void refreshAdminMenuItem();
  document.body.classList.add('menu-open');
  // Preserve a currently occupied desktop scrollbar gutter, but do not add a
  // new gutter to pages/browsers that had none before opening the drawer.
  document.documentElement.classList.toggle('menu-scroll-gutter', window.innerWidth > document.documentElement.clientWidth);
  document.documentElement.classList.add('menu-scroll-locked');
  syncMenuExpandedState(true);
  topbar?.classList.remove('topbar-collapsed');
  const menu = document.querySelector('.global-menu');
  const firstVisibleControl = [...(menu?.querySelectorAll(MENU_FOCUSABLE_SELECTOR) || [])]
    .find((element) => {
      const styles = window.getComputedStyle(element);
      return !element.hidden && styles.display !== 'none' && styles.visibility !== 'hidden';
    });
  focusWithoutScroll(firstVisibleControl);
  isolateMenuBackground();
  menuBackgroundObserver?.disconnect();
  menuBackgroundObserver = new MutationObserver(isolateMenuBackground);
  menuBackgroundObserver.observe(document.body, { childList: true });
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
    secondaryTabs?.classList.toggle('secondary-tabs-scrolled', currentScrollY > TOPBAR_TOP_SCROLL_Y);
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
  let previousSecondaryTabsHeight = -1;

  const syncStickyHeights = () => {
    const topbarHeight = topbar.getBoundingClientRect().height;
    const memberTabsHeight = memberTabs?.getBoundingClientRect().height || 0;
    const secondaryTabsHeight = secondaryTabs?.getBoundingClientRect().height || 0;
    if (Number.isFinite(topbarHeight) && topbarHeight > 0 && Math.abs(topbarHeight - previousTopbarHeight) >= 0.1) {
      previousTopbarHeight = topbarHeight;
      root.style.setProperty('--topbar-sticky-height', `${topbarHeight.toFixed(2)}px`);
    }

    if (Number.isFinite(memberTabsHeight) && memberTabsHeight >= 0 && Math.abs(memberTabsHeight - previousMemberTabsHeight) >= 0.1) {
      previousMemberTabsHeight = memberTabsHeight;
      root.style.setProperty('--member-tabs-sticky-height', `${memberTabsHeight.toFixed(2)}px`);
    }

    if (Number.isFinite(secondaryTabsHeight) && secondaryTabsHeight >= 0 && Math.abs(secondaryTabsHeight - previousSecondaryTabsHeight) >= 0.1) {
      previousSecondaryTabsHeight = secondaryTabsHeight;
      root.style.setProperty('--secondary-tabs-sticky-height', `${secondaryTabsHeight.toFixed(2)}px`);
    }
  };

  syncStickyHeights();
  window.addEventListener('resize', syncStickyHeights, { passive: true });

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(syncStickyHeights);
    observer.observe(topbar, { box: 'border-box' });
    if (memberTabs) observer.observe(memberTabs, { box: 'border-box' });
    if (secondaryTabs) observer.observe(secondaryTabs, { box: 'border-box' });
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
  const profileSubtext = isLoggedIn
    ? (user?.email || 'Logged in')
    : RELEASE_GATES.publicSignupEnabled
      ? 'Join the 77-day challenge'
      : 'Invite-only early access';

  const menuHadFocus = menu.contains(document.activeElement);
  menu.innerHTML = `
    <div class="global-menu-header">
      <div>
        <p class="eyebrow">Dominion</p>
        <h2 data-menu-profile-label></h2>
        <span data-menu-profile-subtext></span>
      </div>
      <button class="global-menu-close" type="button" aria-label="Close menu">×</button>
    </div>
    <nav class="global-menu-links" aria-label="Global navigation" data-training-target="global-navigation">
      ${links.map(([label, href]) => `<a href="${href}">${label}</a>`).join('')}
    </nav>
    <nav class="global-menu-policy-links" aria-label="Policies and support">
      <a href="./privacy.html">Privacy</a>
      <a href="./terms.html">Terms</a>
      ${RELEASE_GATES.billingEnabled
        ? '<a href="./cancellation-refunds.html">Cancellation &amp; Refunds</a>'
        : ''}
      <a href="./support.html">Support</a>
    </nav>
    ${isLoggedIn ? `
      <section class="global-menu-training-section" aria-label="Training" hidden>
        <p class="eyebrow">Training</p>
        <p class="global-menu-training-load-status" role="status" hidden></p>
        <button class="global-menu-training-load-recovery" type="button" hidden></button>
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
    ${isLoggedIn ? '<button class="global-menu-logout" type="button">Log Out</button><p class="global-menu-logout-feedback" role="alert" aria-live="assertive" hidden></p>' : ''}
  `;
  // Auth/window-focus hydration replaces drawer controls. Keep an open menu's
  // keyboard context inside the fresh drawer instead of leaving focus on body.
  if (menuHadFocus && document.body.classList.contains('menu-open')) {
    focusWithoutScroll(menu.querySelector('.global-menu-links a'));
  }
  // Names and email addresses are text, never markup—even on an admin page.
  menu.querySelector('[data-menu-profile-label]').textContent = profileLabel;
  menu.querySelector('[data-menu-profile-subtext]').textContent = profileSubtext;

  const trailingActions = topbar.querySelector('.topbar-trailing-actions');
  if (!document.body.classList.contains('menu-open')) (trailingActions || topbar).appendChild(button);
  syncMenuExpandedState(document.body.classList.contains('menu-open'));
  menu.querySelector('.global-menu-close')?.addEventListener('click', closeMenu);
  menu.querySelector('.global-menu-logout')?.addEventListener('click', async (event) => {
    const logout = event.currentTarget;
    if (logout.disabled) return;
    logout.disabled = true;
    const feedback = menu.querySelector('.global-menu-logout-feedback');
    feedback.hidden = true;
    closeShareComposer('logout');
    destroyTrainingControllers();
    sharedHeaderActions?.destroy();
    sharedHeaderActions = null;
    currentMenuOwner = '';
    clearThemeEntitlementState();
    try {
      await clearAuthSession();
      closeMenu();
      window.location.href = './index.html';
    } catch {
      // Foreground/Auth hydration may have replaced the drawer controls while
      // the provider request was pending. Report failure in the current UI.
      const currentFeedback = menu.querySelector('.global-menu-logout-feedback');
      const currentLogout = menu.querySelector('.global-menu-logout');
      if (currentFeedback) {
        currentFeedback.textContent = 'Sign out could not be confirmed. Retry signing out before leaving this device.';
        currentFeedback.hidden = false;
      }
      if (currentLogout) {
        currentLogout.disabled = false;
        focusWithoutScroll(currentLogout);
      }
    }
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
  // The regular navigation is already interactive before this optional graph
  // loads. Public pages and visitors never download member training modules.
  currentMenuOwner = nextOwner;
  // Admin readiness is independent of the optional training graph. Start its
  // existing actor-fenced refresh even if the import is delayed or fails.
  void refreshAdminMenuItem();
  if (isLoggedIn && nextOwner && hasSiteTrainingRoute(window.location?.pathname || '')) {
    const section = menu.querySelector('.global-menu-training-section');
    const loadStatus = menu.querySelector('.global-menu-training-load-status');
    const recoveryButton = menu.querySelector('.global-menu-training-load-recovery');
    section.hidden = false;
    loadStatus.hidden = false;
    loadStatus.textContent = 'Loading training…';
    let controllers;
    try {
      controllers = await loadMenuTrainingControllers();
    } catch (error) {
      if (requestId !== menuHydrationRequest || currentMenuOwner !== nextOwner) return;
      trainingLoadRecovery ||= createSiteTrainingLoadRecovery({ id: 'menu-training-load-recovery' });
      trainingLoadRecovery.record(error);
      loadStatus.textContent = TRAINING_RELOAD_MESSAGE;
      recoveryButton.textContent = TRAINING_RELOAD_LABEL;
      recoveryButton.hidden = false;
      recoveryButton.addEventListener('click', () => {
        const trigger = closeMenuForTraining();
        trainingLoadRecovery?.open(trigger);
      });
      return;
    }
    // Auth/focus rehydration, logout, and pagehide can happen during import.
    // Old continuations may cache public code but must not create actor-owned
    // controllers, make reads, attach controls, or auto-open a walkthrough.
    if (requestId !== menuHydrationRequest || currentMenuOwner !== nextOwner) return;
    loadStatus.hidden = true;
    section.hidden = true;
    const { createPageTrainingControls, createSoloFirstRunTraining } = controllers;
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
        beforeOpen: closeMenuForTraining,
      });
      if (nextTraining.available) {
        soloFirstRunTraining = nextTraining;
        currentTrainingOwner = nextOwner;
        const training = soloFirstRunTraining;
        void Promise.resolve(pageTrainingRefresh).then(() => {
          if (training === soloFirstRunTraining && currentMenuOwner === nextOwner) return training.refresh();
        });
      } else {
        nextTraining.destroy();
      }
    } else {
      const training = soloFirstRunTraining;
      void Promise.resolve(pageTrainingRefresh).then(() => {
        if (training === soloFirstRunTraining && currentMenuOwner === nextOwner) return training.refresh({
          autoOpen: false,
          consumeHandoff: false,
        });
      });
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
  removeAdminMenuItem();
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
      void hydrateThemeEntitlementState({ expectedUserId: nextOwner }).then(({ error }) => {
        if (error) console.warn('Unable to verify theme reward ownership', error);
      });
    }
  }, 0);
});

window.addEventListener('storage', (event) => {
  if (['dominion:user', 'dominion:mockUserId', 'dominion:mockUserIdsByIdentity'].includes(event.key)) {
    menuHydrationRequest += 1;
    closeShareComposer('storage-account-change');
    sharedHeaderActions?.destroy();
    sharedHeaderActions = null;
    destroyTrainingControllers();
    currentMenuOwner = '';
    clearThemeEntitlementState();
    closeMenu();
    void buildMenu().then(async () => {
      const user = await getLocalOrSessionUser();
      if (!user?.authenticated || !user.userId) return;
      const result = await hydrateThemeEntitlementState({ expectedUserId: user.userId });
      if (result.error) console.warn('Unable to verify theme reward ownership', result.error);
    });
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

window.addEventListener('pagehide', () => {
  menuHydrationRequest += 1;
  destroyTrainingControllers();
  closeMenu();
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) void buildMenu();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void buildMenu();
});
