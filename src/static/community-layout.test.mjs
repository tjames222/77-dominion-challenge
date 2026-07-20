import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const communityHtml = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
const billingHtml = readFileSync(new URL('../../billing.html', import.meta.url), 'utf8');
const communityCss = readFileSync(new URL('../assets/community.css', import.meta.url), 'utf8');
const communityJs = readFileSync(new URL('./community.js', import.meta.url), 'utf8');
const apiJs = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const retirementMigration = readFileSync(
  new URL('../../supabase/migrations/20260719100000_remove_global_community.sql', import.meta.url),
  'utf8',
);
const privateSocialRetirementMigration = readFileSync(
  new URL('../../supabase/migrations/20260720120000_retire_private_group_social.sql', import.meta.url),
  'utf8',
);

describe('private-only Community', () => {
  test('offers only the private group and private journal destinations', () => {
    const tabNames = [...communityHtml.matchAll(/class="community-tab[^>]*>([^<]+)<\/button>/g)]
      .map((match) => match[1].trim());

    assert.deepEqual(tabNames, ['Private Group', 'Private Journal']);
    assert.doesNotMatch(communityHtml, /id="global(?:-tab|Feed|Leaderboard|PostForm|PostBody)?"/);
    assert.doesNotMatch(communityHtml, /Global Community|Global Leaderboard|Post Globally/);
  });

  test('removes global feed and leaderboard calls from the production client', () => {
    assert.doesNotMatch(communityJs, /refreshGlobal|getCommunityPosts|scope:\s*['"]global['"]/);
    assert.doesNotMatch(apiJs, /get_global_leaderboard|scope\s*=\s*['"]global['"]|scope:\s*['"]global['"]/);
    assert.match(apiJs, /client\.rpc\(['"]get_crew_leaderboard['"]/);
  });

  test('revokes global backend access without deleting retained history', () => {
    assert.match(retirementMigration, /drop function if exists public\.get_global_leaderboard\(text\)/);
    assert.match(retirementMigration, /cp\.scope = 'crew'/);
    assert.doesNotMatch(retirementMigration, /delete\s+from\s+public\.community_posts/i);
  });
});

describe('simplified private groups', () => {
  test('keeps group access, members, leaderboard, integrations, and the Private Journal', () => {
    for (const id of [
      'crewForm',
      'crewSelect',
      'copyInviteButton',
      'crewMemberList',
      'crewLeaderboard',
      'crewIntegrationsCard',
      'journalForm',
      'journalTimeline',
    ]) {
      assert.match(communityHtml, new RegExp(`id=["']${id}["']`));
    }
    assert.match(communityHtml, /Use the connected Slack or Discord channel for conversation/);
  });

  test('removes every private social surface and its client state and handlers', () => {
    assert.doesNotMatch(communityHtml, /crewPost|crewFeed|Private Group Feed|Post to Private Group|Posts loaded/);
    assert.doesNotMatch(communityJs, /CommunityPost|PostComment|PostLiked|crewPosts|crewFeed|data-(?:like|comment|edit|delete)-post/);
    assert.doesNotMatch(communityCss, /\.(?:post-actions|comment-form|reaction-row|private-feed-scroll|post-image)(?:\W|$)/);
    assert.match(apiJs, /description: 'A private mock crew for testing invites, members, and leaderboards\.'/);
    assert.equal((apiJs.match(/invites, posts, comments/g) || []).length, 1);
    assert.doesNotMatch(billingHtml, /community posts, comments, and likes/i);
  });

  test('removes social data and image operations from the supported browser API', () => {
    assert.doesNotMatch(apiJs, /export async function (?:getCommunityPostPage|createCommunityPost|updateCommunityPost|deleteCommunityPost|setPostLiked|addPostComment|deletePostComment)/);
    assert.doesNotMatch(apiJs, /\.from\(['"](?:community_posts|post_likes|post_comments|community-post-images)['"]\)/);
  });

  test('retires database and storage access without purging retained history', () => {
    assert.match(privateSocialRetirementMigration, /revoke all on public\.community_posts from public, anon, authenticated/);
    assert.match(privateSocialRetirementMigration, /drop policy if exists "Crew members can read community post images"/);
    assert.match(privateSocialRetirementMigration, /revoke execute on function public\.get_community_post_engagement\(uuid\[\]\)/);
    assert.doesNotMatch(privateSocialRetirementMigration, /(?:delete|truncate|drop table)\s+(?:from\s+)?public\.(?:community_posts|post_comments|post_likes)/i);
    assert.doesNotMatch(privateSocialRetirementMigration, /delete\s+from\s+storage\.objects/i);
  });
});
