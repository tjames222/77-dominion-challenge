# Journal date validation dependency boundary

The shared API imported two pure date validators from the calendar UI module.
Extracting the unchanged functions and constants prevents unrelated routes from
loading the journal calendar. The picker keeps compatible re-exports and imports
the validator locally for its selection handler.

The existing menu group remains entry-aware. Its 30,000-byte subgroup merge
threshold avoids adding a separate dialog request after this extraction. This
is a bundling optimization, not an authorization boundary; the actual built-graph
test rejects menu listeners, calendar/dialog UI, and training presentation on
Account Security. No CSS source or grouping changed. The optional CSS-grouping
experiment was deliberately not included.

See the [Rolldown subgroup threshold reference](https://rolldown.rs/reference/TypeAlias.CodeSplittingGroup#entriesawaremergethreshold).
The pinned Rolldown 1.1.5 declaration supports the same option.

## Measurements and validation

An isolated comparison against source `89ccd1c` reduced initial JavaScript by
about 2.4 KB gzip on each of the seven budgeted routes and 5.5 KB on Account
Security, with unchanged request counts and byte-identical Security CSS.

The integrated candidate also includes the independently reviewed Auth lifecycle
fix `056d9b2`. Its canonical mock-only develop build (Night enabled) measures:

| Route | Initial JS gzip bytes | Initial CSS gzip bytes | Requests |
| --- | ---: | ---: | ---: |
| Landing | 140483 | 38091 | 10 |
| Login | 143808 | 35281 | 11 |
| Dashboard | 160059 | 36283 | 12 |
| Rewards | 152320 | 39326 | 11 |
| Community | 165897 | 43495 | 12 |
| Profile | 146854 | 35281 | 9 |
| Bible reading | 146061 | 35281 | 9 |
| Account Security | 127048 | 29603 | 7 |

The unchanged performance checker still fails interim ceilings and all seven
completion targets. This is partial FOU-1501 progress, not ticket completion.

- 940 frontend unit tests pass, including actual integrated build-graph
  assertions and pure-validator re-export identity checks.
- 42 production-built MFA and 78 production-built Admin browser tests pass in
  Chromium and mobile WebKit, using only the localhost synthetic provider.
- The mock-only canonical build verifies all 28 entrypoints and asset contracts.
- Both existing journal creation/edit and accessible-calendar browser tests pass
  against that built artifact in Chromium, without weakening assertions.
- Independent review confirmed byte-identical validator bodies, retained menu
  behavior, optional training boundaries, and the no-CSS scope.

Linux visual generation and final exact-head protected checks remain release
requirements. No hosted database, authentication setting, grant, or deployment
was changed during this implementation.
