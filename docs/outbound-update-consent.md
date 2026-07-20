# Outbound group update consent

FOU-554 owns a member's approval to send Dominion activity to an external group destination. It does not own Slack/Discord connection records and screens (FOU-541), provider/runtime provisioning (FOU-553), or event delivery behavior (FOU-542).

## Fail-closed rules

- A missing `outbound_update_preferences` row means no consent. Existing members and newly joined members therefore start opted out without a backfill.
- Preferences are scoped to one member and one crew membership. Removing that membership, deleting the crew, or deleting the account cascades the current preference away and records a payload-free revocation audit entry. Rejoining creates a new, opted-out consent lifecycle.
- The global switch and the event-specific switch must both be on. Supported event keys are `check_in`, `streak_milestone`, `badge_reward`, and `membership`; null or unknown keys are denied.
- Presentation defaults to `anonymous`. A named update may use only the member's current profile display name. Prayer content, journal content, action notes, email, billing details, and other private payloads are outside this contract.

Members may read and change only their own row. Crew owners and admins have no override. Every change is captured by an immutable trigger in `outbound_update_preference_audit`; that table contains consent metadata only, never an event or message payload.

## FOU-542 delivery and retry hook

The stable worker RPC is:

```sql
public.get_current_outbound_consent(member_uuid, crew_uuid, event_type)
```

It returns contract `schemaVersion: 1`, the current revision and presentation mode, event flags, `eligible`, a denial `reason`, and `destinationCheckRequired: true`. Authenticated clients may resolve only themselves; the delivery worker uses its service-role JWT to resolve the member attached to a queued event.

FOU-542 maps its provider-neutral source events to the consent categories below. Unknown categories fail closed.

| Source event | Consent category |
| --- | --- |
| Submitted Daily Check-In | `check_in` |
| Supported streak milestone | `streak_milestone` |
| Badge or reward unlock | `badge_reward` |
| New private-group member | `membership` |

An optional leaderboard recap is not itself permission to name or enumerate members. Keep it aggregate/anonymous, or resolve every included member against an applicable approved category.

FOU-542 must run these steps for the first attempt and every retry, immediately before sending:

1. Resolve current consent with the queued member, crew, and concrete event type.
2. If `eligible` is false, cancel the queued attempt as a terminal privacy decision. Do not retry it after a later opt-in.
3. Ask the FOU-541 destination adapter, backed by the FOU-553 runtime, for the current connection and verify it is connected, authorized, and still belongs to the crew. Cancel when it is disconnected or removed.
4. Render either the current profile name or “A group member” from `presentationMode`, then send.
5. If transport fails and a retry is scheduled, repeat all checks; never reuse an earlier consent or destination snapshot.

This ordering makes opt-out, anonymization changes, membership removal, destination disconnect, and account deletion effective for already queued work. It also avoids coupling this migration to a destination or queue table that does not exist yet.

FOU-553's current outbox does not carry a dedicated subject member or support a worker-owned `cancelled` settlement after a claim. FOU-542 therefore needs a follow-on queue contract that:

- carries `subject_user_id` as private delivery metadata, never inside the provider payload;
- returns that subject from the claim RPC so the worker can call the consent resolver;
- cancels a claimed delivery with a safe reason such as `consent_revoked`, `membership_missing`, `account_missing`, or `destination_inactive` without treating it as a provider failure; and
- rechecks the FOU-541 destination after claim, because the claim result contains a connection snapshot that can become stale before transport.

Do not add a queue foreign key that silently erases the only cancellation signal on account deletion. Either retain the private subject UUID through terminal cancellation under the delivery retention policy, or perform an atomic account-deletion cancellation before redaction.

## FOU-541 and FOU-553 adapter

The profile page calls `getOutboundIntegrationDestinations(crewId)` from `src/static/api.js`. It currently returns the honest empty state and imports no destination table. When FOU-541 is integrated on top of the FOU-553 runtime, replace that adapter implementation with its current connected-destination query:

```js
const result = await manageGroupIntegration('list', { crewId });
return normalizeConnectedDestinations(result.destinations);
```

The normalizer accepts FOU-541's `provider`, `status: 'active'`, `workspaceName`, and `channelName` response and exposes this profile-facing shape:

```js
{
  id: 'destination-id',
  platform: 'slack' | 'discord',
  name: '#channel-or-webhook-label',
  context: 'workspace-or-server-name',
  connected: true,
}
```

Disconnecting a destination does not rewrite member consent. The worker independently requires both current member consent and a current destination connection, so reconnecting cannot deliver old canceled work.
