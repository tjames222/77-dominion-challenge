# Dominion Night Profile selection

Dominion Night is selectable only when both controls agree:

- the `VITE_ENABLE_DOMINION_NIGHT_THEME` release flag enables the registered theme; and
- the authenticated reward catalog returns an active `ownership` reward with `status: owned` whose fulfillment key is `dominion-night`.

The point threshold and progress copy come from the typed reward catalog. The UI does not duplicate the 56-point threshold. Dark and Light remain public choices.

## Fail-closed behavior

Theme authorization exists only in the in-memory theme runtime. It is never written to local storage. Local storage keeps the member's theme preference, not proof of ownership.

At initial page paint, an entitlement theme resolves to Dark. After the authenticated catalog loads, the shared page runtime derives authorized theme IDs and reapplies the stored preference. A missing catalog, inactive reward, missing ownership row, signed-out session, or failed request clears the in-memory authorization and returns the page to Dark while retaining the preference for a future verified session.

## Rollout and rollback

FOU-1494 approves the existing CSS profile and Profile picker for the current
release. Production and canonical develop builds explicitly enable the flag and
reject accidental omission or disablement. The canonical preview remains fully
mocked; production still reconciles ownership against the authenticated reward
catalog. Reward thresholds and ownership are not changed by this release toggle.

Pausing release availability requires a reviewed change to the workflow flag
and its canonical build/artifact guards together, or a separately approved
reward-definition change. Do not bypass the guards with a Cloudflare production
variable, and do not delete reward entitlement rows. Restoring availability
allows members whose ownership remains authoritative to select their theme again.
