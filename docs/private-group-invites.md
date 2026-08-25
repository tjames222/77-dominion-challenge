# Private-group invitation contract

Private-group invitations are a two-step, server-authoritative flow. One issuance creates three representations of the same one-person invitation: **Link**, **Code**, and **QR**. Opening a link, scanning a QR, or entering a code only creates a privacy-safe preview. A membership row is created only after the authenticated recipient presses **Confirm and join group**.

## Browser and authentication flow

1. `issue_crew_invite_bundle(crew_id)` uses the existing issuance lifecycle, rotates any prior active invitation, and returns one raw link secret and one raw join code exactly once. Only an entitled group owner/admin can call it. Opening **Invite People** is read-only; the user must press **Generate invitation**.
2. Link and QR payloads use `invite.html#invite=<secret>`. The selectable 16-character code uses the unambiguous alphabet `34679ACDEFGHJKMNPQRTUVWXY`, is displayed in four groups, and accepts case, spaces, or hyphens at entry. Code deep links, when used, use `invite.html#code=<code>`; code query parameters are never accepted.
3. URL fragments are not sent in HTTP requests or referrers. The invite page captures and removes either credential before its first RPC, redirect, or analytics-capable navigation. Authentication receives only the fixed return path `./invite.html`.
4. `preview_crew_invite(invite_token, null)` preserves the established link behavior. `preview_crew_invite_code(invite_code)` resolves the code to the same invitation. Both return only the group name, inviter first name, expiry, and a random two-hour continuation. Neither preview creates membership.
5. The continuation is held in `sessionStorage`. Login, registration, and membership setup use the fixed invitation return path; neither original credential nor the continuation is placed in a redirect URL. After authentication, the existing `preview_crew_invite(null, continuation)` binds the continuation to that account. A different account receives `wrong_account` with no group details.
6. `confirm_crew_invite(continuation)` remains the only membership boundary. It rechecks issuer authorization, recipient entitlement, expiry, revocation, account binding, one-time use, existing membership, the one-current-crew rule, and capacity while holding row locks. Membership, attribution, redemption, and any attribution-driven reward either commit together or roll back together.
7. The QR is generated in the browser with the pinned local `qrcode` package. It does not call a hosted QR service or request camera permission. Export uses a neutral `dominion-crew-invite.png` filename; file sharing appears only when the browser confirms it can share PNG files.

Legacy `community.html?invite=...` links are immediately moved to the fragment-based invite page. New links and codes never use query parameters. `join_crew_by_invite(text)` has been removed so no client can bypass confirmation.

## Status contract

RPCs return a JSON object with a stable `status` instead of revealing membership through exceptions:

- `ready`: safe preview and continuation are available.
- `joined`: explicit confirmation succeeded.
- `already_member`: the signed-in user already belongs to the group.
- `invalid`, `expired`, `revoked`, `already_used`: terminal link states; no preview is returned.
- `wrong_account`: the continuation is bound to a different account; no preview is returned.
- `full`: current capacity prevents joining; capacity is rechecked on confirmation.
- `subscription_required`: an active entitlement is required at confirmation.
- `session_expired`: the two-hour continuation expired; reopen the original link.
- `rate_limited`: issuance, preview, or confirmation limits were reached.

Failure responses deliberately omit group, roster, email, description, and full inviter identity.

## Persistence and authorization

- `crew_invites` stores the existing link digest plus a keyed code digest and four-character code hint, never either raw credential. The HMAC key is generated inside the database, held in a private RLS-enabled table, and is not granted to client or service roles. A database leak of invite rows alone is therefore insufficient for offline code guessing.
- `crew_invite_sessions` stores only hashed continuations. Authenticated and anonymous clients have no direct table privileges.
- `crew_invite_attributions` is the auditable, one-row-per-redemption record. Its identity fields are immutable and direct client access is denied.
- Private rate-limit buckets store keyed scope digests rather than codes, account IDs, or caller-supplied network identifiers. Valid invitations use the established per-invite preview window and do not consume invalid-guess buckets, so random-guess exhaustion cannot disable a known-valid invite.
- Direct PostgREST RPC calls do not provide a trustworthy client network identity to SQL. The database therefore does not accept an IP or fingerprint from the browser. Deployment-layer IP controls can be added at the edge; database controls remain global, credential-scoped, and authenticated-account-scoped.
- RLS remains enabled on all invitation and private support tables. Admins can read only non-secret active-invitation metadata for groups they manage; they cannot select hashes, recover plaintext, or insert/update invites directly.

## Sharing-reward integration (FOU-562)

On success, `confirm_crew_invite` returns `redemptionId`, which is exactly `crew_invite_attributions.id`. That row contains the immutable, server-only `inviter_user_id`, `recipient_user_id`, `invite_id`, and `crew_id`.

FOU-562 accepts only the redemption ID at its service-only boundary, loads `inviter_user_id` from the attribution row, and grants through an after-insert trigger. It does not trust an inviter ID from the browser. FOU-561 itself intentionally grants no points.

## Verification

- `src/static/crew-invite.test.mjs`, `crew-invite-ui.test.mjs`, and `invite-flow.test.mjs` cover code entropy/normalization, fragment capture and immediate removal, local QR configuration, neutral export, cancellation, fixed auth destinations, continuation storage, lifecycle messaging, account-scoped cleanup, and responsive accessibility contracts.
- `tests/e2e/crew-invite-codes.spec.mjs` decodes the generated QR, proves generation makes no third-party request, exercises clipboard/native share/PNG download and cancellation, verifies plaintext is absent from mock persistence, follows signed-out code entry through authentication and explicit single-use confirmation, and checks mobile accessibility in Light, Dark, and Dominion Night.
- `supabase/tests/database/030_private_group_invites.sql` covers preview-before-membership, confirmation, attribution, replay, wrong account, revoked/expired/used/full/already-member/subscription states, RPC grants, plaintext removal, and rate limiting.
- The crew-code pgTAP suite covers keyed-digest privacy, grants/RLS/BOLA, normalization, invalid-guess limits, link compatibility, code lifecycle parity, issuer-loss rollback, and safe metadata. The crew-code race script confirms Link and Code continuations can race while producing at most one membership, attribution, and reward.
- `supabase/tests/integration/rpc-concurrency.sh` continues to protect link-only confirmation concurrency.
- `pnpm run check:backend` replays migrations, runs pgTAP/concurrency tests, checks schema drift, and validates Edge Functions. Docker, the Supabase CLI, and PostgreSQL client tools are required.
