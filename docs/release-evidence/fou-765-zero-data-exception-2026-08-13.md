# FOU-765 prelaunch zero-data exception — 2026-08-13

## Decision

Product owner Tim James explicitly approved the zero-data exception for FOU-765
in the production-readiness release task. The release operator acknowledged and
recorded that approval at 2026-08-13T19:30:50Z. This exception applies
only because a fresh, aggregate-only production inventory found no member,
group, row, or Storage object affected by the retired Community conversation
surface.

This record authorizes no deletion, purge, backdating, production migration, or
automatic retention schedule.

## Fresh production evidence

- Evidence captured: 2026-08-13T19:39:07Z–2026-08-13T19:39:59Z
- Supabase project: `mimolwojppbtsbvtqwpo`
- Operation: read-only aggregate SQL
- Customer content or identity fields returned: none

```sql
select
  count(*)::bigint as community_posts,
  count(*) filter (where scope = 'global')::bigint as global_posts,
  count(*) filter (where scope = 'crew')::bigint as crew_posts,
  count(distinct author_id)::bigint as post_authors,
  count(distinct crew_id) filter (where crew_id is not null)::bigint
    as affected_groups,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'community_posts'
      and column_name = 'image_path'
  ) as has_image_path_column
from public.community_posts;

select
  (select count(*)::bigint from public.post_comments) as post_comments,
  (select count(*)::bigint from public.post_likes) as post_likes,
  (select count(distinct actor_id)::bigint from (
    select author_id as actor_id from public.community_posts
    union
    select user_id as actor_id from public.post_comments
    union
    select user_id as actor_id from public.post_likes
  ) affected_users) as affected_users,
  (select count(*)::bigint
     from storage.objects
    where bucket_id = 'community-post-images') as community_image_objects;
```

| Aggregate | Count |
| --- | ---: |
| Community posts | 0 |
| Global posts | 0 |
| Crew posts | 0 |
| Post comments | 0 |
| Post likes | 0 |
| Affected users | 0 |
| Affected groups | 0 |
| `community-post-images` objects | 0 |
| Referenced image rows | 0 — the pre-migration table has no `image_path` column |

The result independently reconfirms the broader read-only production inventory
captured in `fou-757-prelaunch-audit-2026-08-13.md`.

## Policy disposition

Because there are no affected users or data:

- no customer notice or member export window is required for this prelaunch
  retirement;
- a retired-Community T0, 30-day export deadline, and day-91 purge date are not
  applicable;
- the export isolation, aggregate worker health, and dry-run controls remain in
  the tested codebase, but the destructive worker stays dormant;
- no retired-Community worker secret, operator cadence, or purge approver is
  assigned for launch because no destructive work exists;
- Tim James remains the product/support owner and exception approver. The
  release automation is the evidence operator for the read-only inventory only.

## Fail-closed release condition

Rerun the exact aggregate inventory immediately before the first production
backend release. Any nonzero count voids this exception and stops the release.
If that happens, follow the complete notice, export, T0, backup, independent
approval, and dry-run process in `docs/retired-community-deletion-runbook.md`.
