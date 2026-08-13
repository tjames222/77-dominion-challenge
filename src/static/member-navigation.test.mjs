import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const dashboard = read('../../dashboard.html');
const rewards = read('../../badges-rewards.html');
const community = read('../../community.html');
const privateJournal = read('../../private-journal.html');
const groupSettings = read('../../group-settings.html');
const communityJs = read('./community.js');
const privateJournalJs = read('./private-journal.js');
const productCss = read('../assets/product.css');
const communityCss = read('../assets/community.css');

function memberNavigation(source) {
  return source.match(/<nav class="member-tabs"[\s\S]*?<\/nav>/)?.[0] || '';
}

function memberLinks(source) {
  return [...memberNavigation(source).matchAll(/<a class="member-tab" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(([, href, content]) => ({
      href,
      label: content
        .replace(/<[^>]+>/g, '')
        .trim(),
    }));
}

describe('FOU-1455 member destination navigation', () => {
  test('renders the same four ordered destinations on every affected page', () => {
    const expected = [
      { href: './dashboard.html', label: 'Dashboard' },
      { href: './badges-rewards.html', label: 'Rewards' },
      { href: './community.html', label: 'Community' },
      { href: './private-journal.html', label: 'Private Journal' },
    ];

    for (const source of [dashboard, rewards, community, privateJournal]) {
      assert.match(memberNavigation(source), /aria-label="Member sections"/);
      assert.deepEqual(memberLinks(source), expected);
      assert.doesNotMatch(memberNavigation(source), /role="tab(?:list)?"|aria-selected|aria-controls/);
    }
  });

  test('marks every direct destination and preserves the legacy journal query as a redirect', () => {
    assert.match(memberNavigation(dashboard), /href="\.\/dashboard\.html" aria-current="page"/);
    assert.match(memberNavigation(rewards), /href="\.\/badges-rewards\.html" aria-current="page"/);
    assert.match(memberNavigation(community), /href="\.\/community\.html" aria-current="page"/);
    assert.match(memberNavigation(privateJournal), /href="\.\/private-journal\.html"[^>]*aria-current="page"/);
    assert.match(communityJs, /get\('view'\) === 'journal'[\s\S]*?window\.location\.replace\('\.\/private-journal\.html'\)/);
    assert.match(privateJournalJs, /const RETURN_PATH = '\.\/private-journal\.html'/);
  });

  test('removes the duplicate Dashboard reward, badge, and Community presentations', () => {
    assert.doesNotMatch(dashboard, /class="progression-badges"|id="badgeShelf"|game-summary-rewards-link/);
    assert.doesNotMatch(dashboard, /section class="community dashboard-section"|id="feed"|id="completedToday"/);
    assert.match(memberNavigation(dashboard), /data-training-target="dashboard-community"/);
  });

  test('keeps the four destinations on one sticky, touch-safe row with progressive labels', () => {
    assert.match(productCss, /\.member-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
    assert.match(productCss, /\.member-tabs\s*\{[\s\S]*?position:\s*sticky/);
    assert.match(productCss, /\.member-tab\s*\{[\s\S]*?min-height:\s*44px/);
    assert.doesNotMatch(productCss, /@media \(max-width: 640px\)[\s\S]*?\.member-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2/);
    assert.match(productCss, /\.member-tab-label\s*\{[\s\S]*?clip:\s*rect\(0, 0, 0, 0\)/);
    assert.match(productCss, /@media \(min-width: 480px\)[\s\S]*?\.member-tab-label\s*\{[\s\S]*?position:\s*static/);
    assert.match(productCss, /\.member-tabs\.member-tabs-collapsed \.member-tab-label/);
    for (const source of [dashboard, rewards, community, privateJournal]) {
      assert.match(memberNavigation(source), /icon-home/);
      assert.match(memberNavigation(source), /icon-gift/);
      assert.match(memberNavigation(source), /icon-users/);
      assert.match(memberNavigation(source), /icon-book/);
      assert.match(memberNavigation(source), /href="\.\/private-journal\.html"[^>]*aria-label="Private Journal"/);
    }
  });

  test('adds one accessible group settings gear and keeps role-gated controls on its own page', () => {
    assert.match(community, /id="crewSettingsButton"[\s\S]*?href="\.\/group-settings\.html"[\s\S]*?aria-label="Group settings"[\s\S]*?title="Group settings"/);
    assert.match(communityJs, /settingsButton\.hidden = !crew/);
    assert.match(groupSettings, /id="groupSettingsContent"[^>]*hidden/);
    assert.match(groupSettings, /id="integrationPrivacy"/);
    assert.match(groupSettings, /id="groupIntegrations"/);
    assert.match(groupSettings, /id="groupAccess"/);
    assert.match(communityCss, /\.crew-settings-link\s*\{[\s\S]*?min-width:\s*48px;[\s\S]*?min-height:\s*48px/);
  });
});
