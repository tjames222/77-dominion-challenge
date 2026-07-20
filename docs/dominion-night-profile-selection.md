# Dominion Night Profile selection

Dominion Night is selectable only when both controls agree:

- the `VITE_ENABLE_DOMINION_NIGHT_THEME` release flag enables the registered theme; and
- the authenticated reward catalog returns an active `ownership` reward with `status: owned` whose fulfillment key is `dominion-night`.

The point threshold and progress copy come from the typed reward catalog. The UI does not duplicate the 500-point threshold. Dark and Light remain public choices.

## Fail-closed behavior

Theme authorization exists only in the in-memory theme runtime. It is never written to local storage. Local storage keeps the member's theme preference, not proof of ownership.

At initial page paint, an entitlement theme resolves to Dark. After the authenticated catalog loads, the shared page runtime derives authorized theme IDs and reapplies the stored preference. A missing catalog, inactive reward, missing ownership row, signed-out session, or failed request clears the in-memory authorization and returns the page to Dark while retaining the preference for a future verified session.

## Rollout and rollback

Enable the CSS profile and Profile picker only after the reward catalog migration is live. Validate locked, partial-progress, owned, request-failure, and signed-out states before enabling the release flag.

To pause the theme, disable the feature flag or reward definition. Do not delete reward entitlement rows. Re-enabling both controls restores selection for members whose ownership is still authoritative.
