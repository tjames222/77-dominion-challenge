# Private-group social retirement

FOU-543 removes Dominion's private-group conversation surface. Group creation, invitations, membership, the private leaderboard, Slack/Discord configuration, and the separate Private Journal remain supported.

## Cutover behavior

- The browser no longer loads or exposes post, comment, reaction, moderation, pagination, or post-image controls.
- Authenticated client roles have no table privileges or RLS policies for `community_posts`, `post_comments`, or `post_likes`.
- The engagement helper and post visibility helper are not executable by browser roles.
- All member policies for the private `community-post-images` bucket are removed.
- Slack and Discord remain outbound-only. Dominion does not import conversations, threads, replies, reactions, or provider members.

The migration deliberately does not delete rows, objects, or the private bucket. Historical data remains service-only. FOU-564 captures an immutable retirement census, offers each authenticated member a time-limited export of only content they authored, and seals deletion work behind backup, independent approval, and worker confirmation. Deployment does not authorize a production purge. See [Retired Community deletion controls](./retired-community-deletion-runbook.md).

The Private Journal uses its own tables and `journal-progress` bucket and is unaffected by this cutover.
