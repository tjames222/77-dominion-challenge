import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const apiSource = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');

test('dashboard fetches three deterministic previews and an independent complete-today count', () => {
  const dashboardApi = apiSource.slice(
    apiSource.indexOf('export async function getDashboard()'),
    apiSource.indexOf('const browserTimeZone', apiSource.indexOf('export async function getDashboard()')),
  );

  assert.match(dashboardApi, /\.order\('created_at', \{ ascending: false \}\)[\s\S]*\.order\('id', \{ ascending: false \}\)[\s\S]*\.limit\(3\)/);
  assert.match(dashboardApi, /select\('id', \{ count: 'exact', head: true \}\)[\s\S]*\.eq\('status', 'complete'\)[\s\S]*\.gte\('created_at', todayBounds\.start\)[\s\S]*\.lt\('created_at', todayBounds\.end\)/);
  assert.match(dashboardApi, /completedTodayCount: Math\.max\(0, Number\(completedTodayResult\.count\) \|\| 0\)/);
});

test('authoritative empty feeds replace starter content and local history is not truncated', () => {
  assert.match(dashboardSource, /if \(Array\.isArray\(dashboard\?\.feed\)\) \{\s*feed = dashboard\.feed;/);
  assert.doesNotMatch(dashboardSource, /feed = \[feedItem, \.\.\.feed\]\.slice\(/);
});
