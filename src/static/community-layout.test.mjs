import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const communityHtml = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
const communityCss = readFileSync(new URL('../assets/community.css', import.meta.url), 'utf8');
const communityJs = readFileSync(new URL('./community.js', import.meta.url), 'utf8');

describe('private Community feed layout', () => {
  test('keeps photo posts in the document scroll flow', () => {
    const feedRules = [...communityCss.matchAll(/\.private-feed-scroll\s*\{([^}]*)\}/g)];
    assert.ok(feedRules.length > 0, 'missing private feed layout rule');

    feedRules.forEach(([, declarations]) => {
      assert.doesNotMatch(declarations, /max-height\s*:/, 'the private feed must not cap its viewport height');
      assert.doesNotMatch(declarations, /(?:^|;)\s*overflow\s*:/, 'the private feed must not use overflow shorthand to create a nested scroller');
      assert.doesNotMatch(declarations, /overflow-y\s*:\s*(?:auto|scroll)/, 'the private feed must not create a nested scroller');
      assert.doesNotMatch(declarations, /overscroll-behavior-y\s*:\s*contain/, 'the private feed must not trap page scrolling');
    });
  });

  test('paginates against the browser viewport without intercepting touch gestures', () => {
    assert.match(communityJs, /root:\s*null,\s*rootMargin:\s*['"]180px 0px['"]/, 'infinite scrolling must observe the page viewport');
    assert.equal(communityJs.includes('setupPullToRefresh'), false, 'the private feed must not intercept page pull gestures');
    assert.equal(communityHtml.includes('crewPullRefreshIndicator'), false, 'the removed pull gesture must not leave stale UI');
    assert.match(communityHtml, /id=["']refreshCrewFeedButton["']/, 'the explicit private feed refresh control must remain available');
    assert.match(communityHtml, /id=["']crewFeedScroll["'][^>]*tabindex=["']-1["']/, 'programmatic focus must not add a redundant tab stop');
  });

  test('releases a focused photo description before hiding it', () => {
    const clearImageBody = communityJs.match(/function clearCrewPostImage\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
    const blurPosition = clearImageBody.indexOf('document.activeElement === altInput) altInput.blur()');
    const hidePosition = clearImageBody.indexOf('altLabel.hidden = true');

    assert.ok(blurPosition >= 0, 'the focused photo description must be blurred');
    assert.ok(hidePosition >= 0, 'the photo description label must still be hidden when cleared');
    assert.ok(blurPosition < hidePosition, 'the focused photo description must be blurred before it is hidden');
  });
});
