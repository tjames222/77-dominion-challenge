import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { calculateLevelProgress } from './point-economy.mjs';
import {
  MEMBER_PROGRESS_BADGE_PAGE_SIZE,
  MEMBER_PROGRESS_REVALIDATION_COOLDOWN_MS,
  MEMBER_PROGRESS_UNAVAILABLE,
  MEMBER_BADGE_CURSOR_RESTART,
  MEMBER_BADGE_CURSOR_RESTART_CODE,
  createMemberProgressRevalidationGate,
  createMemberProgressRequestGate,
  memberProgressRoleLabel,
  mergeMemberProgressBadgePage,
  mockLifetimeLevel,
  mapMemberProgressRpcError,
  normalizeMemberProgressCursor,
  paginateMemberProgressBadges,
  normalizeMemberProgressBadge,
  normalizeMemberProgressProfile,
} from './member-progress-profile.mjs';

const communityJs = readFileSync(new URL('./community.js', import.meta.url), 'utf8');
const apiJs = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const communityCss = readFileSync(new URL('../assets/community.css', import.meta.url), 'utf8');

function profile(overrides = {}) {
  return {
    memberId: 'member-b',
    displayName: 'Micah Reed',
    avatarUrl: '',
    role: 'member',
    level: 31,
    badgeCount: 2,
    badges: [
      {
        key: 'newest',
        name: 'Newest',
        description: 'Newest badge',
        tier: 'gold',
        icon: 'crown',
        earnedAt: '2026-02-14T20:00:00.000Z',
      },
    ],
    hasMore: true,
    nextCursor: {
      earnedAt: '2026-02-14T20:00:00.000Z',
      badgeKey: 'newest',
    },
    ...overrides,
  };
}

describe('member progress presentation contract', () => {
  test('scoped awards retain UUID identity without private scope or provenance', () => {
    const firstId = 'a1510000-0000-4000-8000-000000000001';
    const secondId = 'a1510000-0000-4000-8000-000000000002';
    const first = { ...profile().badges[0], awardId: firstId, scopeKey: 'lifetime', metadata: { secret: true } };
    const second = { ...first, awardId: secondId, scopeKey: 'original77:2026-01-01' };
    const merged = mergeMemberProgressBadgePage(profile({ badges: [first] }), profile({
      badges: [first, second], hasMore: false, nextCursor: null,
    }));
    assert.deepEqual(merged.badges.map(badge => badge.awardId), [firstId, secondId]);
    assert.deepEqual(Object.keys(merged.badges[0]).sort(), ['awardId', 'description', 'earnedAt', 'icon', 'key', 'name', 'tier']);
    assert.deepEqual(mergeMemberProgressBadgePage(merged, merged).badges, merged.badges);
  });

  test('cursor preserves database microseconds and rejects malformed UUIDs', () => {
    const cursor = { earnedAt: '2026-09-13T07:00:00.123456+00:00', badgeKey: 'seven_sealed', awardId: 'a1510000-0000-4000-8000-000000000001' };
    assert.deepEqual(normalizeMemberProgressCursor(cursor), cursor);
    assert.deepEqual(normalizeMemberProgressProfile(profile({ nextCursor: cursor })).nextCursor, cursor);
    assert.equal(normalizeMemberProgressCursor({ ...cursor, awardId: 'not-an-id' }), null);
    assert.equal(normalizeMemberProgressCursor({ ...cursor, earnedAt: null }), null);
    assert.equal(normalizeMemberProgressCursor({ ...cursor, badgeKey: '' }), null);
    assert.equal(normalizeMemberProgressCursor({ ...cursor, badgeKey: 42 }), null);
    assert.equal(normalizeMemberProgressCursor({ ...cursor, awardId: [cursor.awardId] }), null);
  });

  test('preview follows UUID ties, permits unique legacy cursors, and restarts ambiguous or stale cursors', () => {
    const badges = [3, 1, 2].map(n => ({ ...profile().badges[0], awardId: `a1510000-0000-4000-8000-00000000000${n}` }));
    const first = paginateMemberProgressBadges(badges, null, 1);
    const second = paginateMemberProgressBadges(badges, first.nextCursor, 1);
    const third = paginateMemberProgressBadges(badges, second.nextCursor, 1);
    assert.deepEqual([first, second, third].flatMap(p => p.badges.map(b => b.awardId)), [...badges].map(b => b.awardId).sort());
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, null);
    const { awardId, ...legacy } = first.nextCursor;
    assert.throws(() => paginateMemberProgressBadges(badges, legacy, 1), { code: MEMBER_BADGE_CURSOR_RESTART_CODE });
    assert.throws(() => paginateMemberProgressBadges(badges.slice(0, 1), first.nextCursor, 1), { code: MEMBER_BADGE_CURSOR_RESTART_CODE });
    assert.equal(paginateMemberProgressBadges([badges[1]], legacy, 1).badges.length, 0);
  });

  test('real API body forwards stable cursors and maps only the fixed server restart signal after actor verification', async () => {
    const start = apiJs.indexOf('export async function getCrewMemberProgressProfile');
    const end = apiJs.indexOf('export async function getOrCreateCrewInvite', start);
    const source = apiJs.slice(start, end).replace('export async function', 'async function');
    const cursor = { earnedAt: '2026-09-13T07:00:00.123456+00:00', badgeKey: 'seven_sealed', awardId: 'a1510000-0000-4000-8000-000000000001' };
    const calls = [];
    let response = { data: profile({ nextCursor: cursor }) };
    const dependencies = {
      MEMBER_PROGRESS_BADGE_PAGE_SIZE, MEMBER_PROGRESS_UNAVAILABLE, normalizeMemberProgressCursor,
      normalizeMemberProgressProfile, mapMemberProgressRpcError,
      isLocalDemoMode: () => false,
      requireSupabase: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return response; } }),
      requireUser: async id => { calls.push(id); return { id: 'actor-a' }; },
      canonicalProfilePhotoUrl: () => '', SUPABASE_ORIGIN: '', PROFILE_PHOTO_BUCKET: '',
    };
    const api = new Function(...Object.keys(dependencies), `${source}; return getCrewMemberProgressProfile;`)(...Object.values(dependencies));
    const result = await api({ crewId: 'crew-a', userId: 'member-b', expectedUserId: 'actor-a', cursor, limit: 99 });
    assert.deepEqual(result.nextCursor, cursor);
    assert.deepEqual(calls, ['actor-a', {
      name: 'get_crew_member_progress_profile', args: {
        target_crew_id: 'crew-a', target_user_id: 'member-b', target_badge_cursor_earned_at: cursor.earnedAt,
        target_badge_cursor_key: cursor.badgeKey, target_badge_limit: 24, target_badge_cursor_award_id: cursor.awardId,
      },
    }, 'actor-a']);
    response = { error: { code: '22023', details: 'member_badge_cursor_restart_required', message: 'private SQL diagnostic' } };
    await assert.rejects(api({ crewId: 'crew-a', userId: 'member-b' }), {
      code: MEMBER_BADGE_CURSOR_RESTART_CODE, message: MEMBER_BADGE_CURSOR_RESTART,
    });
    const other = { code: '22023', details: 'other' };
    assert.equal(mapMemberProgressRpcError(other), other);
    assert.equal(calls.at(-1), 'actor-a');
  });
  test('normalizes only minimum presentation fields and strips raw metadata', () => {
    const normalized = normalizeMemberProgressProfile({
      ...profile(),
      exactPoints: 420,
      email: 'private@example.test',
      badges: [{
        ...profile().badges[0],
        metadata: { journal: 'private' },
        category: 'internal',
      }],
    }, { expectedMemberId: 'member-b' });

    assert.deepEqual(Object.keys(normalized).sort(), [
      'avatarUrl',
      'badgeCount',
      'badges',
      'displayName',
      'hasMore',
      'level',
      'memberId',
      'nextCursor',
      'role',
    ]);
    assert.deepEqual(Object.keys(normalized.badges[0]).sort(), [
      'description', 'earnedAt', 'icon', 'key', 'name', 'tier',
    ]);
    assert.equal('metadata' in normalized.badges[0], false);
    assert.equal('exactPoints' in normalized, false);
    assert.equal('email' in normalized, false);
  });

  test('sanitizes text, icon, tier, counts, and cursor data fail closed', () => {
    const badge = normalizeMemberProgressBadge({
      key: 'safe\u0000-key',
      name: 'Name\u0007',
      description: 'Description\nline',
      tier: 'platinum',
      icon: 'shield onclick=bad',
      earnedAt: 'not-a-date',
    });
    assert.deepEqual(badge, {
      key: 'safe-key',
      name: 'Name',
      description: 'Descriptionline',
      tier: 'bronze',
      icon: 'shield',
      earnedAt: '',
    });

    const normalized = normalizeMemberProgressProfile(profile({
      level: -3,
      badgeCount: -1,
      badges: [],
      hasMore: true,
      nextCursor: { earnedAt: 'invalid', badgeKey: 'next' },
    }));
    assert.equal(normalized.level, 1);
    assert.equal(normalized.badgeCount, 0);
    assert.equal(normalized.hasMore, false);
    assert.equal(normalized.nextCursor, null);
    assert.throws(
      () => normalizeMemberProgressProfile(profile(), { expectedMemberId: 'someone-else' }),
      new RegExp(MEMBER_PROGRESS_UNAVAILABLE),
    );
  });

  test('merges keyset pages without duplicates and preserves server refresh fields', () => {
    const merged = mergeMemberProgressBadgePage(profile(), profile({
      displayName: 'Micah Updated',
      role: 'admin',
      level: 32,
      badges: [
        profile().badges[0],
        {
          key: 'older',
          name: 'Older',
          description: 'Older badge',
          tier: 'silver',
          icon: 'shield',
          earnedAt: '2026-02-10T20:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    }));
    assert.equal(merged.displayName, 'Micah Updated');
    assert.equal(merged.role, 'admin');
    assert.equal(merged.level, 32);
    assert.deepEqual(merged.badges.map((badge) => badge.key), ['newest', 'older']);
    assert.equal(merged.hasMore, false);
  });

  test('uses the shared lifetime level calculator at every boundary', () => {
    for (const points of [0, 1, 13, 14, 27, 28, 419, 420, 750]) {
      assert.equal(mockLifetimeLevel(points), calculateLevelProgress(points).level);
    }
    assert.equal(MEMBER_PROGRESS_BADGE_PAGE_SIZE, 12);
  });

  test('labels every crew role without relying on color', () => {
    assert.equal(memberProgressRoleLabel('owner'), 'Group leader');
    assert.equal(memberProgressRoleLabel('admin'), 'Leader');
    assert.equal(memberProgressRoleLabel('member'), 'Member');
  });
});

describe('member progress request race gate', () => {
  test('invalidates an older member when another selection wins', () => {
    const gate = createMemberProgressRequestGate();
    const first = gate.begin({ crewId: 'crew-a', memberId: 'member-a' });
    const second = gate.begin({ crewId: 'crew-a', memberId: 'member-b' });
    assert.equal(gate.isCurrent(first), false);
    assert.equal(gate.isCurrent(second, { crewId: 'crew-a', memberId: 'member-b' }), true);
  });

  test('invalidates requests on crew, sign-out, or dialog close clearing', () => {
    const gate = createMemberProgressRequestGate();
    const request = gate.begin({ crewId: 'crew-a', memberId: 'member-a' });
    assert.equal(gate.pendingFor('crew-a', 'member-a'), true);
    gate.invalidate();
    assert.equal(gate.isCurrent(request), false);
    assert.equal(gate.pendingFor('crew-a', 'member-a'), false);
  });

  test('separates a badge-page request from a duplicate profile open', () => {
    const gate = createMemberProgressRequestGate();
    const request = gate.begin({ crewId: 'crew-a', memberId: 'member-a', kind: 'badges' });
    assert.equal(gate.pendingFor('crew-a', 'member-a', 'profile'), false);
    assert.equal(gate.pendingFor('crew-a', 'member-a', 'badges'), true);
    assert.equal(gate.isCurrent(request), true);
  });

  test('deduplicates foreground revalidation and invalidates stale completions after reset', () => {
    let now = 10_000;
    const gate = createMemberProgressRevalidationGate({ now: () => now });
    const first = gate.begin();
    assert.deepEqual(first, { revision: 1 });
    assert.equal(gate.inFlight, true);
    assert.equal(gate.begin(), null);
    assert.equal(gate.finish(first), true);

    now += MEMBER_PROGRESS_REVALIDATION_COOLDOWN_MS - 1;
    assert.equal(gate.begin(), null);
    now += 1;
    const second = gate.begin();
    assert.deepEqual(second, { revision: 2 });

    gate.reset();
    const replacement = gate.begin({ bypassCooldown: true });
    assert.deepEqual(replacement, { revision: 4 });
    assert.equal(gate.finish(second), false);
    assert.equal(gate.inFlight, true);
    assert.equal(gate.finish(replacement), true);
    assert.equal(gate.inFlight, false);
  });

  test('lets an access-sensitive roster result bypass cooldown without duplicating an in-flight RPC', () => {
    let now = 500;
    const gate = createMemberProgressRevalidationGate({ now: () => now });
    const foreground = gate.begin();
    assert.ok(foreground);
    assert.equal(gate.begin({ bypassCooldown: true }), null);
    assert.equal(gate.finish(foreground), true);

    now += 1;
    const roster = gate.begin({ bypassCooldown: true });
    assert.ok(roster);
    assert.equal(gate.finish(roster), true);
  });
});

describe('Community member progress integration source', () => {
  test('uses one server RPC with bounded keyset pagination and no direct cross-user reads', () => {
    assert.match(apiJs, /client\.rpc\('get_crew_member_progress_profile'/);
    assert.match(apiJs, /target_badge_cursor_earned_at/);
    assert.match(apiJs, /target_badge_limit: normalizedLimit/);
    assert.doesNotMatch(communityJs, /POINTS_PER_LEVEL|calculateLevelProgress/);
    assert.doesNotMatch(communityJs, /\.from\(['"](?:profiles|user_game_stats|game_point_events|user_badges)['"]\)/);
  });

  test('renders semantic roster and leaderboard triggers with exact accessible names', () => {
    assert.match(communityJs, /<button[\s\S]*?data-member-progress-user-id/);
    assert.match(communityJs, /View \$\{name \|\| 'Member'\}’s level and badges/);
    assert.match(communityJs, /leaderboard-member-trigger/);
  });

  test('revalidates the captured actor after mock and production RPC waits', () => {
    const start = apiJs.indexOf('export async function getCrewMemberProgressProfile');
    const end = apiJs.indexOf('export async function getOrCreateCrewInvite', start);
    const profileApi = apiJs.slice(start, end);
    const rpcCall = profileApi.indexOf("client.rpc('get_crew_member_progress_profile'");
    const postflightActorCheck = profileApi.indexOf('await requireUser(actor.id)', rpcCall);
    const normalization = profileApi.indexOf('normalizeMemberProgressProfile(data', rpcCall);

    assert.ok(rpcCall > 0);
    assert.ok(postflightActorCheck > rpcCall);
    assert.ok(normalization > postflightActorCheck);
    assert.match(profileApi, /const actorId = getMockUserId\(\);[\s\S]*?await Promise\.resolve\(\);[\s\S]*?!getMockBillingState\(\)\.authenticated \|\| getMockUserId\(\) !== actorId/);
  });

  test('uses shared dialog semantics, request invalidation, and access-change clearing', () => {
    assert.match(communityJs, /createDialog\(\{/);
    assert.match(communityJs, /presentation: 'responsive'/);
    assert.match(communityJs, /progress\.gate\.invalidate\(\)/);
    assert.match(communityJs, /subscribeToAuthStateChanges/);
    assert.match(communityJs, /cross-tab-access-change/);
    assert.match(communityJs, /reconcileOpenMemberProgress/);
    assert.match(communityJs, /async function revalidateOpenMemberProgress/);
    assert.match(communityJs, /kind: 'revalidate'/);
    assert.match(communityJs, /progress\.profile = null;[\s\S]*?renderMemberProgressDialog\(\);[\s\S]*?getCrewMemberProgressProfile/);
    assert.match(communityJs, /finally \{[\s\S]*?revalidateOpenMemberProgress\(\{ bypassCooldown: true \}\)/);
    assert.match(communityJs, /addEventListener\('focus', revalidateMemberProgressAfterForegroundSignal\)/);
    assert.match(communityJs, /addEventListener\('visibilitychange', revalidateMemberProgressAfterForegroundSignal\)/);
    assert.match(communityJs, /addEventListener\('online', revalidateMemberProgressAfterReconnect\)/);
    assert.match(communityJs, /clearMemberProgress\(\{ reason: 'pagehide' \}\)/);
    assert.doesNotMatch(communityJs, /clearMemberProgress\(\{ close: false \}\)/);
  });

  test('provides 44px controls, responsive badges, themes, focus, and reduced motion', () => {
    assert.match(communityCss, /\.leaderboard-member-trigger[\s\S]*?min-height: 44px/);
    assert.match(communityCss, /\.member-progress-load-more[\s\S]*?min-height: 44px/);
    assert.match(communityCss, /\.member-progress-badges[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(communityCss, /@media \(max-width: 520px\)[\s\S]*?\.member-progress-badges[\s\S]*?grid-template-columns: 1fr/);
    assert.match(communityCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.leaderboard-member-trigger/);
    assert.doesNotMatch(communityCss, /#[0-9a-f]{3,8}\s*;\s*\/\*\s*member progress/i);
  });
});
