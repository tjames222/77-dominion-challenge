import '../assets/reward-celebrations.css';
import { acquireDialogLayer } from './dialog.mjs';

const element = (document, tag, className, text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

export function presentPermanentRewardCelebration(item, {
  document = globalThis.document,
  dismiss,
  complete,
  navigate = (href) => document.defaultView.location.assign(href),
} = {}) {
  const reward = item.rewards[0];
  const layer = element(document, 'div', 'permanent-reward-celebration');
  layer.id = 'permanentRewardCelebration';
  layer.dataset.rewardKeys = item.rewardKeys.join(',');
  const panel = element(document, 'section', 'permanent-reward-celebration__card');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'permanentRewardEyebrow permanentRewardTitle');
  panel.setAttribute('aria-describedby', 'permanentRewardDescription');
  panel.tabIndex = -1;
  const close = element(document, 'button', 'permanent-reward-celebration__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close reward celebration');
  close.addEventListener('click', () => dismiss('close'));
  const visual = element(document, 'div', 'permanent-reward-celebration__visual');
  const fallback = element(document, 'span', `app-icon icon-${item.consolidated ? 'gift' : reward.icon}`);
  fallback.setAttribute('aria-hidden', 'true');
  visual.append(fallback);
  if (!item.consolidated && reward.artwork) {
    const artwork = element(document, 'img', 'permanent-reward-celebration__artwork');
    artwork.alt = reward.artworkAlt;
    artwork.addEventListener('load', () => { fallback.hidden = true; });
    artwork.addEventListener('error', () => { artwork.remove(); fallback.hidden = false; });
    artwork.src = reward.artwork;
    visual.append(artwork);
  }
  const eyebrow = element(document, 'p', 'permanent-reward-celebration__eyebrow', item.consolidated ? 'Rewards unlocked' : 'Reward unlocked');
  eyebrow.id = 'permanentRewardEyebrow';
  const title = element(document, 'h2', '', item.consolidated ? `${item.rewards.length} rewards are yours` : reward.title);
  title.id = 'permanentRewardTitle';
  const description = element(document, 'p', 'permanent-reward-celebration__description', item.consolidated
    ? 'Your reward collection has grown. View your rewards to see everything you have earned.'
    : reward.description);
  description.id = 'permanentRewardDescription';
  panel.append(close, visual, eyebrow, title, description);
  if (!item.consolidated && reward.milestonePoints) {
    panel.append(element(document, 'p', 'permanent-reward-celebration__milestone', `${reward.milestonePoints.toLocaleString()}-point milestone`));
  }
  panel.append(element(document, 'p', 'permanent-reward-celebration__owned', 'Permanently added to your rewards'));
  const actions = element(document, 'div', 'permanent-reward-celebration__actions');
  const view = element(document, 'a', 'permanent-reward-celebration__primary', item.consolidated ? 'View Rewards' : 'View Reward');
  view.href = item.href;
  view.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    dismiss('view');
  });
  const next = element(document, 'button', 'permanent-reward-celebration__secondary', 'Continue');
  next.type = 'button';
  next.addEventListener('click', () => dismiss('continue'));
  actions.append(view, next);
  panel.append(actions);
  layer.append(panel);
  layer.addEventListener('click', (event) => { if (event.target === layer) dismiss('backdrop'); });
  document.body.append(layer);
  if (!document.defaultView.getComputedStyle(fallback).getPropertyValue('--icon').trim()) {
    fallback.className = 'app-icon icon-gift';
  }
  const ownership = acquireDialogLayer({ document, layer, panel,
    onEscape: () => dismiss('escape'), onReplace: () => dismiss('replaced'),
  });
  ownership.focus(view);
  let cleaned = false;
  return {
    dismiss() {
      layer.classList.add('is-leaving');
      return new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); layer.removeEventListener('animationend', finish); resolve(); };
        const timer = setTimeout(finish, document.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
        layer.addEventListener('animationend', finish, { once: true });
      });
    },
    cleanup(reason) {
      if (cleaned) return;
      cleaned = true;
      ownership.release();
      layer.remove();
      complete(item, reason);
      if (reason === 'view') navigate(item.href);
    },
  };
}
