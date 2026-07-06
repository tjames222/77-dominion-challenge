const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};

const user = load('dominion:user', null);
const isLoggedIn = Boolean(user?.authenticated);
const topbar = document.querySelector('.topbar');

const loggedInLinks = [
  ['Dashboard', './dashboard.html'],
  ['Community', './community.html'],
  ["Today’s Actions", './today-actions.html'],
  ['Check-In', './dashboard.html#check-in'],
  ['Profile', './profile.html'],
];

const publicLinks = [
  ['Home', './index.html'],
  ['Learn Why', './science.html'],
  ['Log In', './login.html'],
  ['Register', './register.html'],
];

function closeMenu() {
  document.body.classList.remove('menu-open');
  document.querySelector('.global-menu-button')?.setAttribute('aria-expanded', 'false');
}

function openMenu() {
  document.body.classList.add('menu-open');
  document.querySelector('.global-menu-button')?.setAttribute('aria-expanded', 'true');
}

function buildMenu() {
  if (!topbar || document.querySelector('.global-menu')) return;

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
  menu.querySelector('.global-menu-logout')?.addEventListener('click', () => {
    localStorage.removeItem('dominion:user');
    closeMenu();
    window.location.href = './index.html';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
}

buildMenu();
