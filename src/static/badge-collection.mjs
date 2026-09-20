import { createBadgeGallery } from './badge-gallery.mjs';
import { iconClass, normalizeEarnedBadges } from './badges-rewards.mjs';

const SERIES = new Map([
  ['foundation', 'Getting started'], ['check_in_progress', 'Check-in milestones'],
  ['progress', 'Check-in milestones'], ['participation', 'Check-in milestones'], ['perfect_streak', 'Perfect-day streaks'],
  ['workout', 'Workout achievements'], ['app_streak', 'Showing up'],
  ['community', 'Community'], ['completion', 'Challenge completion'],
  ['legacy', 'Legacy collection'], ['other', 'More achievements'],
]);
const METRIC_LABELS = new Map([
  ['check_in_count', 'check-ins'], ['instance_check_in_count', 'check-ins'],
  ['partial_count', 'partial check-ins'], ['perfect_count', 'perfect check-ins'],
  ['perfect_streak', 'consecutive perfect days'], ['app_streak', 'consecutive app days'],
]);
const text = (value, limit = 1200) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const seriesKey = (value) => SERIES.has(value) ? value : 'other';
let collectionSequence = 0;

// Presentation only: progress and current-scope ownership must come from the
// actor-bound catalog read. The UI never evaluates eligibility from totals.
export function badgeCollectionModel({ collection, awards = [] } = {}) {
  if (collection?.catalogVersion !== 1 || !Array.isArray(collection.items)) {
    throw new Error('Badge requirements are temporarily unavailable.');
  }
  const definitions = new Map();
  for (const item of collection.items) {
    const key = text(item?.key, 200);
    if (!key || definitions.has(key)) continue;
    definitions.set(key, item);
  }
  const groups = new Map();
  const ensureGroup = (key, order = 10000) => {
    if (!groups.has(key)) groups.set(key, { key, label: SERIES.get(key), order, earned: [], locked: [] });
    const group = groups.get(key);
    group.order = Math.min(group.order, order);
    return group;
  };
  const earned = normalizeEarnedBadges(awards);
  for (const badge of earned) {
    const definition = definitions.get(badge.key);
    const key = badge.legacy || badge.retired ? 'legacy' : seriesKey(definition?.series || badge.category);
    const order = key === 'legacy' ? 20000 : Number.isFinite(definition?.displayOrder) ? definition.displayOrder : 10000;
    ensureGroup(key, order).earned.push(badge);
  }
  for (const definition of definitions.values()) {
    if (definition.visibility !== 'public' || !['active', 'blocked'].includes(definition.status)
      || definition.earnedInCurrentScope === true) continue;
    const metricLabel = METRIC_LABELS.get(definition.progress?.metric);
    const current = definition.progress?.current;
    const target = definition.progress?.target;
    const hasProgress = definition.status === 'active' && definition.showProgress === true
      && metricLabel && Number.isSafeInteger(current) && current >= 0
      && Number.isSafeInteger(target) && target > 0;
    const tier = ['bronze', 'silver', 'gold'].includes(definition.tier) ? definition.tier : 'bronze';
    const order = Number.isFinite(definition.displayOrder) ? definition.displayOrder : 10000;
    ensureGroup(seriesKey(definition.series), order).locked.push({
      key: text(definition.key, 200), name: text(definition.name, 200) || 'Badge',
      requirement: text(definition.requirement) || 'Requirement details are unavailable.',
      iconClass: iconClass(definition.icon, 'shield'), tier, order,
      status: definition.status === 'blocked' ? 'Not available yet' : 'Not yet earned',
      progress: hasProgress ? { current: Math.min(current, target), target,
        label: `${Math.min(current, target)} of ${target} ${metricLabel}` } : null,
    });
  }
  return {
    earnedCount: earned.length,
    groups: [...groups.values()].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
      .map((group) => ({ ...group, locked: group.locked.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)) })),
  };
}

const element = (document, tag, className, value = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
};

export function createBadgeCollection(container) {
  const document = container.ownerDocument;
  const collectionId = `badge-collection-${++collectionSequence}`;
  const groups = new Map();
  let headingIndex = 0;
  const empty = element(document, 'p', 'badge-collection-empty', 'Your first badge is waiting. Post an honest check-in to begin your collection.');
  container.classList.remove('badges-gallery');
  container.classList.add('badge-collection');

  function lockedCard(badge) {
    const card = element(document, 'li', 'badge-requirement-card');
    card.dataset.badgeRequirement = badge.key;
    const symbol = element(document, 'span', 'badge-requirement-symbol');
    symbol.setAttribute('aria-hidden', 'true');
    symbol.append(element(document, 'span', `app-icon ${badge.iconClass}`));
    const copy = element(document, 'div', 'badge-requirement-copy');
    copy.append(element(document, 'span', 'badge-requirement-status', `${badge.status} · ${badge.tier[0].toUpperCase()}${badge.tier.slice(1)}`),
      element(document, 'h4', '', badge.name), element(document, 'p', '', badge.requirement));
    if (badge.progress) {
      const progress = element(document, 'div', 'badge-requirement-progress');
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', `${badge.name}: ${badge.progress.label}`);
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', String(badge.progress.target));
      progress.setAttribute('aria-valuenow', String(badge.progress.current));
      progress.setAttribute('aria-valuetext', badge.progress.label);
      const fill = element(document, 'span', '');
      fill.style.width = `${100 * badge.progress.current / badge.progress.target}%`;
      progress.append(fill);
      copy.append(progress, element(document, 'small', 'badge-requirement-progress-label', badge.progress.label));
    }
    card.append(symbol, copy);
    return card;
  }

  return {
    render(payload) {
      const model = badgeCollectionModel(payload);
      const keys = new Set(model.groups.map((group) => group.key));
      for (const [key, group] of groups) {
        if (!keys.has(key)) { group.gallery.destroy(); group.section.remove(); groups.delete(key); }
      }
      container.querySelectorAll('[data-badge-placeholder]').forEach((node) => node.remove());
      empty.hidden = model.earnedCount > 0;
      container.prepend(empty);
      model.groups.forEach((group, index) => {
        let rendered = groups.get(group.key);
        if (!rendered) {
          const section = element(document, 'section', 'badge-series');
          section.dataset.badgeSeries = group.key;
          const heading = element(document, 'h3', '', group.label);
          heading.id = `${collectionId}-series-title-${++headingIndex}`;
          section.setAttribute('aria-labelledby', heading.id);
          const earned = element(document, 'div', 'badges-gallery badge-series-earned');
          earned.setAttribute('aria-label', `Earned ${group.label.toLowerCase()} badges`);
          const locked = element(document, 'ul', 'badge-requirements-list');
          locked.setAttribute('aria-label', `${group.label} requirements`);
          section.append(heading, earned, locked);
          rendered = { section, earned, locked, gallery: createBadgeGallery(earned) };
          groups.set(group.key, rendered);
        }
        rendered.gallery.render(group.earned);
        rendered.earned.hidden = !group.earned.length;
        rendered.locked.replaceChildren(...group.locked.map(lockedCard));
        rendered.locked.hidden = !group.locked.length;
        // Moving the existing section retains dialog origin nodes across reads.
        if (container.children[index + 1] !== rendered.section) {
          container.insertBefore(rendered.section, container.children[index + 1] || null);
        }
      });
      container.setAttribute('aria-busy', 'false');
      return model.earnedCount;
    },
    clear() {
      for (const group of groups.values()) group.gallery.destroy();
      groups.clear();
      container.replaceChildren();
    },
    destroy() { this.clear(); },
  };
}
