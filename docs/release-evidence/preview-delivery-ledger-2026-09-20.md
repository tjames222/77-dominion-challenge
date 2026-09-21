# Preview celebration delivery ledger — September 20, 2026

Application/test checkpoint: `d851154e4f40c13fda7a927c0e6ea66f8b55cd3f`, based on the reviewed next-batch checkpoint `c42d124339197998b1d110b31220e622d5789b85`. This record does not claim a completed protected merge or deployment.

## Cause and scope

The old preview implementation could read stale localStorage after another tab's exclusive WebLock callback had completed. A bounded Linux WebKit observation run (`35507692530`, source `3ec0ff07fcee5b5795651691577af0e34fa8cc16`) retained 91 passes and nine duplicate-claim failures across 100 first attempts. All nine failures showed installed, retained observers in both pages, serialized callbacks, and a stale second read of the same unclaimed award. This does not show broken native lock exclusivity or establish a production failure rate. The diagnostic workflow is not part of this release.

Preview delivery now uses a lazy native IndexedDB ledger keyed by actor, delivery kind and item. One readwrite transaction owns claim selection and acknowledgment, and success is published only after transaction completion plus the original session/actor checks. Canonical empty rows and seen receipts cannot be replaced by stale legacy snapshots. Unknown IDs cannot manufacture receipts. Existing selection/order/batch/lease semantics remain intact.

Storage/schema failures fail closed without resetting data or falling back to localStorage. Badge-history presentation remains readable without delivery storage. The ledger owns delivery leases/receipts only: badge generation, points, reward ownership/completion rules and legacy history durability are not redesigned. Already-open pre-ledger preview tabs must reload; mixed old/new tabs are outside the new guarantee.

Production RPC branches, migrations, workflow policy and provider configuration are unchanged by this fix. Develop remains mock-only; main remains live-wired. No hosted role grant, admin bootstrap, testing entitlement renewal, reset, new project, paid service or Stripe activation is included.

## Verified local evidence

- Clean checkpoint unit suite: **1,042 passed**, zero failures/skips.
- Focused delivery/boundary units: **38 passed**; native-module probes: **22 passed** across Chromium/WebKit.
- Compiled preview and real-SDK hybrid boundary suite: **68 passed**, zero retries; includes native cross-tab, reload, stale-source, aborted/denied/malformed storage and queued actor/session replacement.
- Original badge/reward/failure suites: **68 passed**, zero retries; canonical receipt observers preserve existing behavioral, offline/reconnect and original-owner assertions. Final pre-presentation receipt assertion separately passed both engines.
- Existing production-built Admin **140**, MFA **44**, Daily Action **66**, and Vite-dev hybrid Auth **7** passed with unchanged application hashes and zero retries.
- Optional public/Security runtime boundary: **2 passed**; all-entry build contract: **4 passed**.
- Main browser discovery remains **1,164 tests**; the separate preview inventory is **68**. No tests, screenshots, tolerances or retry policies were removed or relaxed.
- Canonical main and develop builds passed at the clean checkpoint. Main retains the exact share worker; develop emits neither share worker nor worker routes.

Both paired 28-route graphs used the actual unchanged Vite configuration against `c42d124`. Initial request counts and module inventories are identical, and CSS hashes/gzip bytes are identical. Shared API code adds **824–827 bytes gzip per main route** and **823–829 bytes per develop route**. The lazy ledger does not enter initial route graphs. This is a correctness fix, not completion of FOU-1501's performance targets.

Exact Auth assertions are now three canonical user reads for presentation-only badge history, six for cold/warm badge delivery, and three for unchanged badge-event generation. History uses one owner-bound snapshot instead of a nested earned read; delivery retains immutable owner checks across its new asynchronous boundaries. Pure mocks remain provider-free.

Application SHA-256:

- `src/static/api.js`: `916ebac73b0a52b4adc0dde4e70615da59d70982c567e0368a7222c583f7b02a`
- `src/static/preview-delivery-ledger.mjs`: `25297ea74e13516dfa78eaebd66fee73f4a13503c3ea87834838ce482ad09395`
- `src/static/preview-badge-boundary.mjs`: `b1200b4bfca2bc7df726416d0fffcdc2612f7e850a638649e146cb718a563472`

Independent review found and closed malformed-store validation, unknown acknowledgment admission, unnecessary history storage dependency and transaction-local fixture-read issues. Final observation adapters were independently reviewed. Exact final-source protected Linux checks remain required before merge; local evidence and old-code diagnostics do not replace them.
