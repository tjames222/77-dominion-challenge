import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { adminUserListFacts } from './admin-user-presentation.mjs';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const fixture = () => ({
  role: 'member', createdAt: '2026-01-02T06:00:00-08:00', emailConfirmedAt: '2026-01-03T14:01:02Z', lastSignInAt: '2026-01-04T14:02:03+00:00',
  crew: { name: 'Synthetic crew', role: 'admin' },
  statsSnapshot: { totalPoints: 0, storedAppStreak: 0, storedPerfectDayStreak: 0, lastSeenLocalDate: '2026-01-03', recordedAt: '2026-01-04T00:01:02Z' },
  subscriptionSnapshot: { status: 'active', currentPeriodEnd: '2026-02-04T00:00:00Z', cancelAtPeriodEnd: false, recordedAt: '2026-01-04T00:02:03Z' },
});

test('account facts use the fixed existing payload and explicitly UTC timestamps', () => {
  const facts = adminUserListFacts(fixture());
  assert.deepEqual(facts.account, [['Site role', 'Member'], ['Created', '2026-01-02 14:00:00 UTC'],
    ['Email confirmed', '2026-01-03 14:01:02 UTC'], ['Last sign-in', '2026-01-04 14:02:03 UTC']]);
  assert.deepEqual(facts.crew, [['Name', 'Synthetic crew'], ['Crew-local role', 'Admin']]);
  assert.deepEqual(facts.snapshotSummary, [['Stored points', '0'], ['Stored subscription', 'Active']]);
});
test('zero counters and false cancellation are not confused with missing values', () => {
  const facts = adminUserListFacts(fixture());
  assert.deepEqual(facts.snapshots[0], { title: 'Stored progress snapshot', fields: [
    ['Stored total points', '0'], ['Stored app streak', '0'], ['Stored perfect-day streak', '0'],
    ['Last seen local date', '2026-01-03'], ['Recorded', '2026-01-04 00:01:02 UTC'],
  ] });
  assert.deepEqual(facts.snapshots[1].fields, [['Stored status', 'Active'], ['Period end', '2026-02-04 00:00:00 UTC'],
    ['Cancel at period end', 'No'], ['Recorded', '2026-01-04 00:02:03 UTC']]);
  const item = fixture(); item.subscriptionSnapshot.cancelAtPeriodEnd = true;
  assert.equal(adminUserListFacts(item).snapshots[1].fields[2][1], 'Yes');
});
test('missing and invalid dates, missing records and unknown statuses stay truthful', () => {
  const facts = adminUserListFacts({ role: 'unrecognized', createdAt: null, emailConfirmedAt: 'invalid', lastSignInAt: '2026-99-99T00:00:00Z', crew: null });
  assert.deepEqual(facts.account.map((pair) => pair[1]), ['Unknown', 'Not recorded', 'Not recorded', 'Not recorded']);
  assert.equal(facts.crew, null); assert.ok(facts.snapshots.every((snapshot) => snapshot.fields === null));
  assert.deepEqual(facts.snapshotSummary, [['Stored points', 'Not recorded'], ['Stored subscription', 'Not recorded']]);
  const item = fixture(); item.subscriptionSnapshot = { status: 'unknown', cancelAtPeriodEnd: null }; item.statsSnapshot = { totalPoints: null };
  assert.equal(adminUserListFacts(item).snapshots[1].fields[0][1], 'Unknown');
  assert.equal(adminUserListFacts(item).snapshots[1].fields[2][1], 'Not recorded');
  for (const value of ['unrecognized', '__proto__', 'constructor']) {
    item.subscriptionSnapshot.status = value; assert.equal(adminUserListFacts(item).snapshotSummary[1][1], 'Unknown');
  }
});
test('presentation never derives live access or advances stored historical values', () => {
  const item = fixture(); const original = structuredClone(item);
  item.statsSnapshot.recordedAt = '2001-01-01T00:00:00Z'; item.statsSnapshot.storedAppStreak = 7;
  item.subscriptionSnapshot.currentPeriodEnd = '2001-01-01T00:00:00Z';
  const facts = adminUserListFacts(item);
  assert.equal(facts.snapshots[0].fields[1][1], '7'); assert.equal(facts.snapshots[1].fields[0][1], 'Active');
  assert.doesNotMatch(JSON.stringify(facts), /currentDay|currentStreak|appAccess|subscriptionActive|entitlement|expired/i);
  assert.deepEqual(adminUserListFacts(original), adminUserListFacts(fixture()));
  assert.equal(item.statsSnapshot.storedAppStreak, 7); assert.equal(item.subscriptionSnapshot.status, 'active');
});
test('only fixed presentation fields are copied, with strings rendered as text by the controller', () => {
  const item = fixture(); item.crew.name = '<img src=x onerror=alert(1)>';
  for (const record of [item, item.crew, item.statsSnapshot, item.subscriptionSnapshot]) record.privatePayload = 'PRIVATE_SENTINEL';
  const facts = adminUserListFacts(item);
  assert.equal(facts.crew[0][1], item.crew.name); assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_SENTINEL/);
  const source = read('./admin.js'); const presentation = read('./admin-user-presentation.mjs');
  assert.match(source, /node\.textContent = text\(value\)/);
  assert.match(source, /const facts = adminUserListFacts\(item\)/);
  assert.doesNotMatch(presentation, /fetch\(|localStorage|sessionStorage|indexedDB|innerHTML|Date\.now|supabase|\.rpc\(/);
});
test('Users alone gets responsive disclosure styles, semantic table headers and truthful scope copy', () => {
  const html = read('../../admin.html'); const source = read('./admin.js'); const css = read('../assets/admin.css');
  assert.match(html, /aria-describedby="adminUsersSnapshotNote"/);
  assert.match(html, /<th role="columnheader" scope="col">Stored snapshots<\/th>/);
  assert.match(html, /class="admin-table" role="table"/);
  assert.match(html, /last-seen dates retain the member's local date/);
  assert.match(html, /Account details and Audit are read-only\. Separately authorized role changes require explicit review and confirmation/);
  assert.match(source, /element\('details', undefined, 'admin-user-snapshots'\)/);
  assert.match(source, /element\('summary', 'View stored snapshots'\)/);
  assert.match(source, /View stored snapshots for \$\{accountLabel\}/);
  assert.match(source, /row\.setAttribute\('role', 'row'\)/);
  assert.match(source, /node\.setAttribute\('role', 'cell'\)/);
  assert.match(source, /element\('h2', snapshot.title\)/);
  for (const line of css.split('\n').filter((line) => /admin-user-|#adminUsersPanel/.test(line))) assert.match(line, /#adminUsersPanel/);
});
