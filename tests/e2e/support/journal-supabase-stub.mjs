import assert from 'node:assert/strict';
import { installAdminStub } from './admin-supabase-stub.mjs';

const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json',
  headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(value) });
const uuid = (n) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`;
const compare = (a, b) => b.entry_date.localeCompare(a.entry_date)
  || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

// Synthetic HTTP rows around the actual production SDK/transport. No mocked
// application methods or hosted requests; SQL authority is tested separately.
export async function installJournalStub(context, { count = 63 } = {}) {
  const auth = await installAdminStub(context, { role: 'member' });
  const tokens = new Map([[auth.firstSession.access_token, auth.A]]);
  const rows = [];
  const reads = []; const writes = []; let sequence = count + 1;
  for (let n = 0; n < count; n += 1) rows.push({
    id: uuid(n + 1), user_id: auth.A, entry_date: '2026-09-01', challenge_day: 1,
    // Same date and same millisecond: cursors must preserve microseconds + id.
    created_at: `2026-09-01T12:00:00.${String(count - n).padStart(6, '0')}Z`,
    updated_at: '2026-09-01T12:00:00.000000Z',
    note: `PRIVATE JOURNAL ${String(n + 1).padStart(4, '0')}`, win: '', prayer: '', mood: 'Focused', energy: 'High',
  });
  rows.push({ id: uuid(999999), user_id: auth.B, entry_date: '2026-09-01', created_at: '2026-09-01T12:00:00.000001Z', updated_at: null,
    challenge_day: null, note: 'OTHER OWNER PRIVATE JOURNAL', win: '', prayer: '', mood: '', energy: '' });
  let holding = null; let holdKind = ''; let failRead = false; let loseWrite = false; let failPolicy = false; let failVerification = false;
  await context.route('**/__admin_fixture__/auth/v1/user', route => failVerification
    ? reply(route, { message: 'PRIVATE RAW VERIFICATION FAILURE', code: 'verification_unavailable' }, 400)
    : route.fallback());
  await context.route('**/__admin_fixture__/rest/v1/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const name = url.pathname.split('/').at(-1);
    const actor = tokens.get((request.headers().authorization || '').replace(/^Bearer\s+/i, ''));
    if (!['journal_entries', 'get_journal_date_policy', 'create_journal_entry', 'update_journal_entry', 'get_member_access_context'].includes(name)) return route.fallback();
    if (!actor) return reply(route, { message: 'Unauthenticated' }, 401);
    if (name === 'get_member_access_context') return reply(route, { schemaVersion: 1, actorId: actor,
      asOf: new Date().toISOString(), appAccess: true, legacyMembershipActive: true,
      paidSubscriptionActive: false, earlyAccessActive: false, earlyAccessProgram: null, earlyAccessEndsAt: null, betaPriceEligible: false });
    if (name === 'get_journal_date_policy') return failPolicy
      ? reply(route, { message: 'PRIVATE RAW POLICY FAILURE' }, 503)
      : reply(route, { time_zone: 'UTC', today: '2026-10-01' });
    if (name === 'journal_entries') {
      assert.equal(request.method(), 'GET');
      assert.equal(url.searchParams.get('user_id'), `eq.${actor}`);
      assert.equal(url.searchParams.get('order'), 'entry_date.desc,created_at.desc,id.desc');
      assert.equal(url.searchParams.get('limit'), '26');
      assert.equal(url.searchParams.has('offset'), false);
      const or = url.searchParams.get('or');
      let result = rows.filter(row => row.user_id === actor).sort(compare);
      if (or) {
        // Check the complete lexicographic predicate rather than silently
        // simulating offset pagination or accepting an arbitrary cursor.
        const date = or.match(/entry_date\.lt\.(\d{4}-\d{2}-\d{2})/)?.[1];
        const created = or.match(/created_at\.lt\.([^,)]+)/)?.[1];
        const id = or.match(/id\.lt\.([a-f0-9-]{36})/)?.[1];
        assert.ok(date && created && id, `Invalid keyset predicate: ${or}`);
        assert.ok(or.includes(`entry_date.eq.${date}`));
        assert.ok(or.includes(`created_at.eq.${created}`));
        const cursor = { entry_date: date, created_at: created, id };
        result = result.filter(row => compare(row, cursor) > 0);
      }
      const snapshot = structuredClone(result.slice(0, 26));
      reads.push({ actor, or, count: snapshot.length, ids: snapshot.map(row => row.id), url: request.url() });
      if (holding && holdKind === 'read') await holding;
      if (failRead) return reply(route, { message: 'PRIVATE RAW JOURNAL FAILURE' }, 503);
      return reply(route, snapshot);
    }
    const body = request.postDataJSON();
    assert.equal(body.target_expected_actor_id, actor);
    writes.push({ actor, name, body });
    let row = name === 'update_journal_entry' ? rows.find(item => item.id === body.target_entry_id && item.user_id === actor) : null;
    if (name === 'update_journal_entry' && !row) return reply(route, { message: 'Not found' }, 404);
    if (!row) { row = { id: uuid(sequence++), user_id: actor, created_at: '2026-10-01T12:00:00.000000Z' }; rows.push(row); }
    Object.assign(row, { entry_date: body.target_entry_date, challenge_day: body.target_challenge_day,
      note: body.target_note, win: body.target_win, prayer: body.target_prayer, mood: body.target_mood,
      energy: body.target_energy, updated_at: '2026-10-01T12:00:00.000000Z' });
    const snapshot = structuredClone(row);
    if (holding && holdKind === 'write') await holding;
    if (loseWrite) return reply(route, { message: 'PRIVATE RAW LOST RESPONSE' }, 502);
    return reply(route, snapshot);
  });
  return { ...auth, rows, reads, writes,
    session(id = auth.A, aal = 'aal2', sid) { const value = auth.session(id, aal, sid); tokens.set(value.access_token, id); return value; },
    hold(kind = 'read') { holdKind = kind; let release; holding = new Promise(resolve => { release = resolve; });
      return () => { release(); holding = null; holdKind = ''; }; },
    failRead(value = true) { failRead = value; }, loseWrite(value = true) { loseWrite = value; },
    failPolicy(value = true) { failPolicy = value; },
    failVerification(value = true) { failVerification = value; },
  };
}

export async function replaceJournalSession(page, value, event = 'SIGNED_IN') {
  await page.evaluate(({ session, eventName }) => {
    if (session) localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    else localStorage.removeItem('sb-127-auth-token');
    const channel = new BroadcastChannel('sb-127-auth-token');
    channel.postMessage({ event: eventName, session }); channel.close();
  }, { session: value, eventName: event });
}
