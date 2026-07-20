import { clearAuthSession, getLocalOrSessionUser } from './api';
import {
  clearThemeEntitlementState,
  hydrateThemeEntitlementState,
} from './theme-entitlement-state';
import { initThemeState } from './theme-state';
import { initThemeAssets } from './theme-assets';

const topbar = document.querySelector('.topbar');

const loggedInLinks = [
  ['Dashboard', './dashboard.html'],
  ['Challenges', './dashboard.html#challengeVault'],
  ['Billing', './billing.html'],
  ['Community', './community.html'],
  ['Check-In', './dashboard.html#check-in'],
  ['Profile', './profile.html'],
];

const publicLinks = [
  ['Home', './index.html'],
  ['Membership', './membership.html'],
  ['Learn Why', './science.html'],
  ['Log In', './login.html'],
];

function closeMenu() {
  document.body.classList.remove('menu-open');
  document.querySelector('.global-menu-button')?.setAttribute('aria-expanded', 'false');
}

function openMenu() {
  document.body.classList.add('menu-open');
  document.querySelector('.global-menu-button')?.setAttribute('aria-expanded', 'true');
}

function initDirectionalTopbar() {
  if (!topbar) return;

  const collapseAfter = 96;
  const directionThreshold = 10;
  let lastScrollY = Math.max(window.scrollY, 0);
  let accumulatedDelta = 0;
  let ticking = false;

  const update = () => {
    const currentScrollY = Math.max(window.scrollY, 0);
    const delta = currentScrollY - lastScrollY;

    if (currentScrollY <= 16) {
      topbar.classList.remove('topbar-collapsed');
      accumulatedDelta = 0;
    } else if (Math.sign(delta) !== Math.sign(accumulatedDelta)) {
      accumulatedDelta = delta;
    } else {
      accumulatedDelta += delta;
    }

    if (!document.body.classList.contains('menu-open')) {
      if (currentScrollY > collapseAfter && accumulatedDelta > directionThreshold) {
        topbar.classList.add('topbar-collapsed');
        accumulatedDelta = 0;
      } else if (accumulatedDelta < -directionThreshold) {
        topbar.classList.remove('topbar-collapsed');
        accumulatedDelta = 0;
      }
    } else {
      topbar.classList.remove('topbar-collapsed');
    }

    topbar.classList.toggle('topbar-scrolled', currentScrollY > 8);
    lastScrollY = currentScrollY;
    ticking = false;
  };

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
  let previousHeight = 0;

  const syncTopbarHeight = () => {
    const height = topbar.getBoundingClientRect().height;
    if (!Number.isFinite(height) || height <= 0 || Math.abs(height - previousHeight) < 0.1) return;

    previousHeight = height;
    root.style.setProperty('--topbar-sticky-height', `${height.toFixed(2)}px`);
  };

  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight, { passive: true });

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(syncTopbarHeight);
    observer.observe(topbar, { box: 'border-box' });
  }
}

async function buildMenu() {
  if (!topbar || document.querySelector('.global-menu')) return;

  const user = await getLocalOrSessionUser();
  const isLoggedIn = Boolean(user?.authenticated);

  const button = document.createElement('button');
  button.className = 'global-menu-button';
  button.type = 'button';
  button.setAttribute('aria-label', 'Open menu');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<span></span><span></span><span></span>';

  const overlay = document.createElement('div');
  overlay.className = 'global-menu-backdrop';

  const menu = document.createElement('aside');
  menu.className = 'global-menu';
  menu.setAttribute('aria-label', 'Global navigation');

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
    <nav class="global-menu-links">
      ${links.map(([label, href]) => `<a href="${href}">${label}</a>`).join('')}
    </nav>
    ${isLoggedIn ? '<button class="global-menu-logout" type="button">Log Out</button>' : ''}
  `;

  topbar.appendChild(button);
  document.body.appendChild(overlay);
  document.body.appendChild(menu);

  button.addEventListener('click', () => {
    document.body.classList.contains('menu-open') ? closeMenu() : openMenu();
  });
  overlay.addEventListener('click', closeMenu);
  menu.querySelector('.global-menu-close')?.addEventListener('click', closeMenu);
  menu.querySelector('.global-menu-logout')?.addEventListener('click', async () => {
    clearThemeEntitlementState();
    await clearAuthSession();
    closeMenu();
    window.location.href = './index.html';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
}

initThemeState();
initThemeAssets();
hydrateThemeEntitlementState().then(({ error }) => {
  if (error) console.warn('Unable to verify theme reward ownership', error);
});
initDirectionalTopbar();
initTopbarStickyOffset();
buildMenu();
