const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let theme = load('dominion:theme', 'dark');
const themeToggle = document.getElementById('themeToggle');
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = `${theme === 'dark' ? 'Dark' : 'Light'} Theme`;
}
themeToggle.addEventListener('click', function () {
  theme = theme === 'dark' ? 'light' : 'dark';
  save('dominion:theme', theme);
  applyTheme();
});
applyTheme();
document.querySelectorAll('.reveal').forEach(function (element) {
  setTimeout(function () { element.classList.add('is-visible'); }, 80);
});
