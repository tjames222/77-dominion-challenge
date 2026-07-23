import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const dashboardHtml = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const dashboardJs = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const productCss = readFileSync(new URL('../assets/product.css', import.meta.url), 'utf8');

describe('dashboard reward presentation', () => {
  it('provides equivalent close, backdrop, and Escape dismissal without dismissing card clicks', () => {
    assert.match(dashboardHtml, /id="badgeCelebration"[^>]*role="dialog"[^>]*aria-modal="true"/);
    assert.match(dashboardHtml, /data-dismiss-celebration aria-label="Dismiss badge celebration"/);
    assert.match(dashboardJs, /event\.target\.closest\('\.badge-medal'\)/);
    assert.match(dashboardJs, /celebrationSequence\.dismissCurrent\('backdrop'\)/);
    assert.match(dashboardJs, /celebrationSequence\.dismissCurrent\('escape'\)/);
    assert.match(dashboardJs, /event\.stopPropagation\(\)/);
    assert.match(productCss, /\.celebration-close[\s\S]*?width:\s*44px[\s\S]*?height:\s*44px/);
  });

  it('uses one event-driven queue and removes fixed delayed badge scheduling', () => {
    assert.match(dashboardJs, /queueCheckInCelebrations\([\s\S]+enqueueCelebrationItems\(items\)/);
    assert.match(dashboardJs, /handoffMs:\s*reducedMotionEnabled\(\) \? 40 : 240/);
    assert.doesNotMatch(dashboardJs, /function\s+queueBadgeCelebrations/);
    assert.doesNotMatch(dashboardJs, /rewardDelay\s*=|unlockDelay\s*=/);
  });

  it('sets the authoritative tier before showing each badge and resets challenge styling', () => {
    for (const tier of ['bronze', 'silver', 'gold']) {
      assert.match(productCss, new RegExp(`\\.badge-celebration\\[data-tier="${tier}"\\]`));
    }
    assert.match(dashboardJs, /stage\.dataset\.tier\s*=\s*tier;[\s\S]*?stage\.hidden\s*=\s*false/);
    assert.match(dashboardJs, /delete stage\.dataset\.tier/);
    assert.match(dashboardJs, /eyebrow\.textContent = `\$\{tierLabel\} Badge Earned`/);
    assert.match(productCss, /var\(--celebration-(?:accent|strong|light|mid|dark)\)/);
  });

  it('renders only the latest badge and preserves the full collection route', () => {
    assert.match(dashboardHtml, />Latest Badge</);
    assert.match(dashboardHtml, /id="badgeShelf" aria-label="Latest earned badge"/);
    assert.match(dashboardHtml, /href="\.\/badges-rewards\.html"/);
    assert.match(dashboardJs, /const latestBadge = selectLatestBadge\(badges\)/);
    assert.match(dashboardJs, /badgeShelf\.innerHTML = latestBadge/);
  });
});
