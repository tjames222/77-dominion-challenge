# Private-group invitation contract

Private-group invitations are a two-step, server-authoritative flow. Opening a link only creates a privacy-safe preview. A membership row is created only after the authenticated recipient presses **Confirm and join group**.

## Browser and authentication flow

1. `issue_crew_invite(crew_id)` rotates any prior active link and returns the new raw secret once. Only an entitled group owner/admin can call it. Issuance is limited to ten links per inviter/group/hour and at least five seconds between rotations.
2. New links use `invite.html#invite=<secret>`. URL fragments are not sent in the HTTP request or referrer. The invite page removes the fragment before its first RPC call.
3. `preview_crew_invite(invite_token, null)` hashes the secret, validates server state, and returns only the group name, inviter first name, and expiry. It also returns a random two-hour continuation. The raw invite is never written to browser storage or the database.
4. The continuation is held in `sessionStorage`. Login and registration receive the fixed return path `./invite.html`; neither the original secret nor the continuation is placed in a redirect URL. Switching between login and registration preserves that fixed path. Membership checkout also returns to the invitation when a continuation is pending.
5. After authentication, `preview_crew_invite(null, continuation)` binds the continuation to that user. A different account receives `wrong_account` with no group details.
6. `confirm_crew_invite(continuation)` rechecks entitlement, expiry, revocation, account binding, one-time use, existing membership, and capacity while holding row locks. Only then does it insert membership and attribution in one transaction.

Legacy `community.html?invite=...` links are immediately moved to the fragment-based invite page. New links never use query parameters. `join_crew_by_invite(text)` has been removed so no client can bypass confirmation.

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

- `crew_invites` stores a SHA-256 hash and six-character hint, never the raw secret. Each link can be redeemed once. Rotation/revocation/expiry are writable only through security-definer RPCs.
- `crew_invite_sessions` stores only hashed continuations. Authenticated and anonymous clients have no direct table privileges.
- `crew_invite_attributions` is the auditable, one-row-per-redemption record. Its identity fields are immutable and direct client access is denied.
- RLS remains enabled on all three tables. Admins can select non-secret invite metadata for groups they manage; they cannot select hashes or insert/update invites directly.

## Sharing-reward integration (FOU-562)

On success, `confirm_crew_invite` returns `redemptionId`, which is exactly `crew_invite_attributions.id`. That row contains the immutable, server-only `inviter_user_id`, `recipient_user_id`, `invite_id`, and `crew_id`.

FOU-562 should accept the redemption ID at its service-only boundary, load the attribution row on the server, and pass its `inviter_user_id` to `record_confirmed_invite_share(inviter_id, redemption_id)`. It must not trust an inviter ID from the browser. FOU-561 intentionally grants no points.

## Verification

- `src/static/invite-flow.test.mjs` covers fragment/query capture, immediate secret removal, fixed auth destinations, continuation storage, and privacy-safe copy.
- `supabase/tests/database/030_private_group_invites.sql` covers preview-before-membership, confirmation, attribution, replay, wrong account, revoked/expired/used/full/already-member/subscription states, RPC grants, plaintext removal, and rate limiting.
- `supabase/tests/integration/rpc-concurrency.sh` races two bound continuations for one invite and requires exactly one new member and one attribution.
- `pnpm run check:backend` replays migrations, runs pgTAP/concurrency tests, checks schema drift, and validates Edge Functions. Docker, the Supabase CLI, and PostgreSQL client tools are required.
