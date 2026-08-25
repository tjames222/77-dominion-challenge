# Sharing reward contract

The Sharing reward is a lifetime bonus of 14 points plus the permanent `sharing` badge. It is separate from the seven Daily Standards points available each day. Its ledger event is `sharing_bonus`, and its lifetime idempotency key is `sharing_bonus:<user-id>`.

## Eligible evidence

| Action | Completion evidence | Trust boundary |
| --- | --- | --- |
| Native share | A short-lived, server-issued intent completed only after `navigator.share()` resolves | The server verifies the authenticated subject, intent age, one-time token, and lifetime grant. The operating system does not provide cryptographic delivery proof, so the successful browser callback remains a bounded client attestation. |
| Copy link | A short-lived, server-issued intent completed only after the Clipboard API resolves | The server verifies the authenticated subject, intent age, one-time token, and lifetime grant. A clipboard write does not prove that another person received the link, so the lifetime cap bounds the attestation. |
| Private-group invite | The immutable redemption ID and original inviter recorded by the server when another account confirms the invite | This evidence is server-authoritative. Creating or viewing an invite is not enough. |

The client must create an intent only after an explicit share action. It must call `complete_sharing_reward` only after the native share or clipboard promise succeeds. A dismissed share sheet, rejected clipboard operation, page view, preview generation, or unconfirmed invite must never call the completion RPC.

Raw completion tokens, URLs, captions, private-group names, recipient data, and shared content are never stored. Intent tokens contain 256 random bits and are persisted only as SHA-256 digests. They expire after 15 minutes. A user may create at most five active intents and ten intents per rolling hour.

## Server APIs

- `create_sharing_reward_intent('native_share' | 'copy_link')` returns a one-time completion token. Creating an intent never grants anything.
- `complete_sharing_reward(token)` consumes eligible client completion evidence and returns the grant or the existing lifetime grant.
- `record_confirmed_group_invite_share(redemption_id)` is executable only by the database owner or service role. It loads the inviter from the immutable attribution row; clients cannot nominate an inviter. An after-insert trigger invokes the same checked path when invite confirmation records that attribution.

The internal grant takes a transaction-scoped user lock, inserts one 14-point ledger event, updates cached point totals, awards the badge with a null `entry_date`, and writes the audit row in the same transaction. Any failure rolls all of those writes back. Null badge dates deliberately avoid the unique daily-badge slot used by Check-Ins.

## Integration order

1. Deploy the seven-point economy and backend CI foundations.
2. Deploy hardened invite attribution (`FOU-561`).
3. Deploy this migration (`FOU-562`).
4. Invite confirmation inserts its immutable attribution row; the trigger grants the inviter reward in the same transaction. The service-only one-argument hook remains retry-safe for reconciliation without duplicating points or badges.
5. The share composer (`FOU-563`) creates and completes native/copy intents around the platform APIs.

Reward progress and next-unlock calculations read `user_game_stats.total_points`, which the atomic grant updates immediately. The all-badges contract reads `badge_definitions` and `user_badges`, so the catalog entry and earned badge appear without a separate client-side badge definition.
