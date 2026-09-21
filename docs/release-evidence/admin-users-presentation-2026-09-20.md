# Admin Users presentation — September 20, 2026

Base: `64dfc40a05d2505fd0c84ce20cf7857887af8387`.
Isolated branch: `epic/admin-users-presentation-2026-09-20`.
This is a bounded FOU-1502 presentation slice, not completion of that ticket or
evidence of a protected merge/deployment.

## Scope

The existing authorized account-list payload now appears in five columns:
Member, Account, Crew, Stored snapshots, and Details. Account groups its site
role/status and UTC creation/confirmation/last-sign-in timestamps. Crew-local
roles are explicitly separate. Stored points/subscription status are historical;
a native, account-labeled disclosure exposes the already-returned counters,
local last-seen date, period end/cancellation flag and snapshot timestamps.

Missing records stay "Not recorded", zero remains zero, and unknown statuses
are not translated into access decisions. An old stored active subscription is
not recomputed as current access or silently relabeled expired. Only fixed
allowlisted fields are copied, and all DOM insertion uses text nodes/attributes.
Expanding the disclosure makes no request or mutation and adds no persistence.

Only the Users layout gains the 1050px card breakpoint; its explicit table,
rowgroup, row, columnheader and cell roles preserve the intended relationships
under that styling. Existing detail dialogs, pagination, filters and lifecycle
scrubbing are unchanged. The stale read-only footnote now distinguishes account
details from the already-existing, separately authorized role-change action.

No API/RPC payload, database migration, Auth/session fence, permission, role
grant, invitation, testing capability or provider setting changes. No external
account operations, hosted data operations, push or deployment were performed
for this slice.

## Local verification

- Full frontend units: **1,048 passed**, no failures/skips.
- Production-built Admin suite with the real installed SDK and local synthetic
  HTTP provider: **148 passed**, Chromium/WebKit, zero retries (140 existing plus
  eight new cases).
- Unchanged mock Admin preview suite: **24 passed**, Chromium/WebKit, zero retries.
- Main browser discovery remains **1,164 tests in 38 files**. Dedicated Admin
  discovery is **148 tests in three files**. No snapshot baselines, thresholds,
  retries or workflow configuration changed.
- New tests cover UTC formatting, null/zero/unknown values, stale historical
  records, private-field omission, markup-as-text, no extra reads/writes from
  disclosure, account-specific accessible names, keyboard Enter/Space, table
  relationships, and removal of expanded state on actor/session invalidation.
- All four themes pass Axe for collapsed/expanded Users and the existing modal.
  Long unbroken fields pass configured-viewport bounds at **390, 768, 1050, 1051
  and 1440px**, with **100% and 200% text**. Existing role/denial/Auth regression
  assertions remain intact.

The first expanded-disclosure accessibility check found a skipped heading level
(`h3` below the page `h1`). A single-case reproduction and trace were retained;
the disclosure heading was corrected to `h2`, with no rule suppression. The
focused 14-case rerun passed before the final 148-case run added explicit roles,
account-specific names and long-field coverage.

Local screenshots were inspected for all four themes on desktop and mobile and
for long-field tablet/desktop breakpoint layouts. Tall element captures may show
the unchanged sticky topbar at the captured scroll position; ordinary viewport
captures are retained separately. These are browser role/keyboard/Axe checks,
**not manual assistive-technology acceptance**. No macOS capture was adopted as
a Linux baseline; protected Linux visual review remains a release prerequisite.

## Independent graph and source review

Paired actual `write:false` builds used the unchanged Vite configuration for
canonical main and develop, substituting exact base HTML/CSS/JavaScript only in
memory. All 27 non-Admin route HTML, ordered JavaScript/CSS hashes, asset
references, initial module inventories, gzip/Brotli totals and request counts
are identical. Admin adds only `admin-user-presentation.mjs`, **686 bytes gzip
of initial JavaScript** and **281 bytes gzip of CSS** in each mode. No route adds
an initial request. Build input hashes and base HEAD stayed unchanged.

The existing performance-budget checker reports the **same ten violations** on
the exact base and candidate in each mode. There is no new violation, but this
does not make the outstanding FOU-1501 budgets pass. Independent source review
found no concrete privacy, authority, lifecycle or presentation blocker.

Durable local logs, screenshots, the failure trace, paired raw graph reports and
the independent audit script are in the sibling operator evidence directory
`admin-users-presentation-evidence-2026-09-20/`, outside browser output cleanup.

Application SHA-256:

- `admin.html`: `faee7824f4598c9d03166427b4d0b39692b9ed85977d38faf25a369707cf406d`
- `src/assets/admin.css`: `cd19cb2cde7c8f3408f32d5e89b2b94fa5c4e744ace27261ed7b1b3d7af04176`
- `src/static/admin.js`: `1d3f886fb634569a1a53930de86b778a8876c3b58e018577182640a8b4bd1c31`
- `src/static/admin-user-presentation.mjs`: `0d4129e4e0cdd9dcb6b0c4ba07366dbd8dba5b7b9282053ad6c5ac81aa2a3316`
