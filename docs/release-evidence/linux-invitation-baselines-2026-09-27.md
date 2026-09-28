# Reviewed Linux invitation baselines — September 27, 2026

Full generation [36366674845](https://github.com/tjames222/77-dominion-challenge/actions/runs/36366674845)
completed successfully on source `ad70dc89806c1761adfba45a167c1134fc850ac5`,
attempt 1. Browser preflight, both complete shards, and the fail-closed combined
verification all passed. The shards contain 593 and 592 outcomes: 1,137 passed
and 48 pre-existing intentional skips. No failed or partial artifact was adopted.

Combined artifact `10948139090` is named
`browser-visual-baselines-ad70dc89806c1761adfba45a167c1134fc850ac5-36366674845-1`.
GitHub reports its archive digest as
`sha256:b1c1d32d194aa910ff8394e0348baf7ad2d59b377f5b688628debf953ce1cc71`.
The downloaded `verification.json` SHA-256 is
`32b7c547aa62d9310055f6ca87cee9bf5fa1b4ec2d90da6d42a6d82f16908448`.

Local verification checked the exact SHA/run/attempt, the 1,185-outcome total, both
shard counts, the exact artifact file inventory, and all 343 decoded PNGs against
their manifest byte lengths and hashes. Against the 334 committed snapshots,
285 regenerated images were byte-identical, 49 existing images differed, and
exactly nine invitation images were new. Only those nine additions are adopted.
No existing snapshot is replaced or removed; comparison tolerances are unchanged.

All nine new images were inspected at original resolution. They show the
intentional missing-capability public guest state, not an accepted invitation or
production account. Terms, price qualification and support copy are readable;
phone wrapping, card edges, header alignment and whitespace are intact without
clipping or overlap. The isolated invitation page deliberately does not load
member-entitlement themes, so requested Dominion Night falls back to Dark.

Paths below are relative to
`tests/e2e/__snapshots__/visual-routes.spec.mjs/`; every filename is
`earlyAccessInvite.png`.

| Directory | Dimensions | SHA-256 |
| --- | --- | --- |
| visual-mobile-light | 390 × 844 | `d8372ddcb708661f1b096ef1657ffaf3015397cdf9671f6c830e95ee1865b037` |
| visual-mobile-dark | 390 × 844 | `d3b2bb43f1a87212010a18ff92cbf6c5784485f13f78883db149523f6e32a8dc` |
| visual-mobile-dominion-night | 390 × 844 | `7927857e6796ed0576ed38ce61af51e3e935cb88c87681a279397539d372e57c` |
| visual-tablet-light | 768 × 1024 | `f11ac669df9cf105d62857676cf00806b8c61f60eaeafd4bf12da6263fcd99d9` |
| visual-tablet-dark | 768 × 1024 | `e99a673a215f51a4182b5c0e07905aaf0008f2d196e44e188644c54ba9088ba7` |
| visual-tablet-dominion-night | 768 × 1024 | `e99a673a215f51a4182b5c0e07905aaf0008f2d196e44e188644c54ba9088ba7` |
| visual-desktop-light | 1440 × 1000 | `88df66b0e7fc62b4a4476a67ac8d2c8be10665a4765c44ba346d31df17acc673` |
| visual-desktop-dark | 1440 × 1000 | `ee26f9f2136e209fe8a2d2e3b3ede1bdb0a09daa2708c983196cdd4c65073889` |
| visual-desktop-dominion-night | 1440 × 1000 | `ee26f9f2136e209fe8a2d2e3b3ede1bdb0a09daa2708c983196cdd4c65073889` |

Release source `3cf8b902eb50336e92e52bb9517649164235342c` has identical
application, HTML, Supabase, Vite, entrypoint, lockfile and browser-test sources
to the generation commit. The ten intervening files concern only the reviewed
pg_net backup preservation helper/tests, backup documentation, CI registration
and its package test command. This adoption adds only the nine PNGs and this
provenance document. Generation is review evidence, not the final protected PR
comparison: all ordinary checks must still pass on the complete candidate for
both develop and main before either merge. This document is not a production
deployment or email-delivery receipt.
