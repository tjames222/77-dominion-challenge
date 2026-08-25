const DEFAULT_TARGETS = [
  '.reveal',
  '.app-shell > .card',
  '.app-shell > .hero-poster',
  '.app-shell > .feature-link',
  '.science-stats',
];

export function initReveal(options = {}) {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const selector = options.selector || DEFAULT_TARGETS.join(',');
  const targets = Array.from(new Set(document.querySelectorAll(selector)));

  targets.forEach((element, index) => {
    element.classList.add('reveal');
    element.style.setProperty('--reveal-order', String(index % 8));
    if (!element.classList.contains('is-visible')) {
      element.classList.add('pending-reveal');
    }
  });

  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    targets.forEach((element) => {
      element.classList.remove('pending-reveal');
      element.classList.add('is-visible');
    });
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.remove('pending-reveal');
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, {
    rootMargin: '0px 0px -10% 0px',
    threshold: 0.12,
  });

  targets.forEach((element) => observer.observe(element));
}
