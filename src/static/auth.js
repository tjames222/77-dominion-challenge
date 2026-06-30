const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let theme = load('dominion:theme', 'dark');
const themeToggle = document.getElementById('themeToggle');
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = `${theme === 'dark' ? 'Dark' : 'Light'} Theme`;
}
themeToggle.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  save('dominion:theme', theme);
  applyTheme();
});
applyTheme();

const form = document.getElementById('authForm');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const nameInput = document.getElementById('name');
  const emailInput = document.getElementById('email');
  const user = {
    name: nameInput ? nameInput.value.trim() : load('dominion:user', { name: 'Member' }).name || 'Member',
    email: emailInput.value.trim(),
    authenticated: true,
  };
  save('dominion:user', user);
  if (user.name) save('dominion:memberName', user.name);
  window.location.href = './dashboard.html';
});
