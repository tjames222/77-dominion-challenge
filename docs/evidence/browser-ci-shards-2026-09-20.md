# Browser CI two-shard preparation — 2026-09-20

Base: `992937f6bcd21815f4b2788ed97f11c9a02796d8`.
This is next-batch CI work only. No workflow was dispatched, no branch protection
was changed, and the ongoing release generation was not modified.

## Preserved gates

Unit tests, production build, hybrid Auth, production-built MFA, Admin and Daily
Action checks still run once as preliminary gates. The main Playwright projects,
assertions, screenshot tolerances, two-worker setting, one-retry policy and test
timeouts are unchanged. Each job retains the 60-minute bound and uses standard
`ubuntu-latest`; no larger/paid runner is requested.

The main matrix is partitioned with Playwright's `--shard=1/2` and `2/2`, with
`fail-fast: false`. The exact required check **Routes, accessibility, and visuals**
is retained as an always-run aggregate that rejects any failed, cancelled,
skipped, missing or unexpected dependency result.

## Artifact boundary

The plan binds the complete discovered inventory to the source SHA, run and
attempt. Both shard reports must cover their exact disjoint partition with
completed outcomes. Existing intentional skips and one-retry successes retain
their original Playwright meaning; discovery-only/unexecuted cases do not pass.

Generation moves each isolated checkout's committed snapshots aside before
running. Only newly emitted PNGs enter that shard's three-day staging artifact.
Comparison runs stage a manifest only. The aggregate downloads shards into
separate directories, rejects symlinks/traversal, verifies content hashes and
complete coverage of committed baseline paths, and rejects conflicting duplicate
paths before writing a combined adoption artifact. Identical duplicate bytes are
accepted. The combined artifact includes a verification manifest and `snapshots/`.

PNG checks are not header-only: they validate chunk boundaries and CRCs, unique
first IHDR/final IEND, contiguous IDAT, exact bounded inflated scanlines, valid
filter bytes, and then decode with Playwright's already-pinned PNG implementation.
The accepted screenshot format is non-interlaced RGB8/RGBA8. All 325 current
committed PNGs are RGB8/non-interlaced and passed this validator. The dependency
lockfile and package versions are unchanged.

No partial artifact can be adopted automatically. A pull request with zero
committed baselines receives complete review evidence but fails the aggregate
until reviewed PNGs are committed. Attempt binding intentionally requires
**Re-run all jobs** rather than reusing earlier-attempt preflight evidence.

## Local evidence

- Frozen dependency installation succeeded without lockfile changes.
- Real main-matrix discovery: **1,152 = 576 + 576**, disjoint and complete.
- Focused workflow/artifact tests: **39 passed**.
- Full unit suite: **969 passed**, no failures/skips.
- The focused suite executes the pinned Playwright JSON reporter on a synthetic,
  browser-free four-test suite (normal pass, dynamic skip, one-retry pass), then
  exercises the actual prepare/pack/merge CLI in isolated temporary directories.
- Negative tests cover missing/duplicate shards or tests, stale SHA/run/attempt,
  partial outcomes, wrong mode, incomplete path unions, corrupt manifests,
  traversal, symlinks, truncated/forged/corrupt PNGs, invalid zlib/filter bytes,
  incomplete/excess inflated scanlines and conflicting valid PNGs.
- YAML parsed successfully; JavaScript syntax and `git diff --check` passed.

These checks do **not** constitute a full 1,152-test Linux execution or measured
CI runtime improvement. The first future sharded CI run must independently pass
all preserved gates before its artifacts are reviewed or adopted. No browser,
hosted provider, database, deployment or production operation was performed for
this change.

Reference: [Playwright sharding](https://playwright.dev/docs/test-sharding).
