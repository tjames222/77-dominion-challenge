# Admin shell gutter regression — 2026-09-20

Base: `992937f6bcd21815f4b2788ed97f11c9a02796d8`.

## Observed defect and cause

Independent review of Linux generation `35499402874` found new tablet Admin
baselines at 783px wide for a configured 768px viewport. The Admin shell has
1rem horizontal gutters but did not define the shared header's `--shell-pad`.
The header therefore used its larger `clamp(18px, 4vw, 34px)` fallback for
negative margins. No content-hiding or overflow-clipping rule was added.

A mock-only localhost probe measured the same values in Chromium and WebKit:

| Configured CSS viewport | Before header left/right | Before body scroll width | After header left/right | After body scroll width |
| --- | --- | --- | --- | --- |
| 390px | -2 / 392 | 392 | 0 / 390 | 390 |
| 768px | -14.71875 / 782.71875 | 783 | 0 / 768 | 768 |
| 1440px | 96 / 1344 | 1440 | 114 / 1326 | 1440 |

The document element's client/scroll widths and `innerWidth` stayed equal to
the configured viewport throughout. That explains why the existing root-only
horizontal-overflow assertion passed despite the wider full-page capture.
Injecting only `.admin-shell { --shell-pad: 1rem; }` corrected the body and
header geometry; removing that injected rule restored the defect. The probe
blocked external requests and made no hosted-provider calls.

## Change

- Define the Admin shell's shared header gutter as 1rem, matching its existing
  width and padding contract.
- Strengthen the nine existing Admin route visual cases: compare body scroll
  width and both header edges with Playwright's configured viewport width.
  Preserve the shared root-overflow assertion, complete matrix selection,
  screenshot assertions/tolerances, and runtime-error checks.

## Verification

Dependencies installed with `pnpm install --frozen-lockfile`; lockfile unchanged.

The new assertions were first run against an unchanged base mock server:

```sh
E2E_BASE_URL=http://127.0.0.1:4297 pnpm exec playwright test \
  tests/e2e/visual-routes.spec.mjs --grep 'admin visual contract' \
  --project='visual-*' --ignore-snapshots --workers=2 --reporter=line
```

Result: six expected failures at the new body-width assertion (all three
mobile themes at 392 > 390; all three tablet themes at 783 > 768), three desktop
passes. The same command against the isolated fixed mock server on port 4298
passed all nine cases.

Additional fixed-source verification:

- `pnpm test`: 940 passed, no failures or skips.
- Existing `admin-preview.spec.mjs` in `chromium-functional` and
  `webkit-admin-mobile`: 24 passed, including accessibility, enlarged text,
  account/audit/early-access views, private-state clearing and navigation.
- `git diff --check`: passed.

Local geometry runs used `--ignore-snapshots` explicitly to avoid accepting
macOS images as Linux baselines; this option is not committed to configuration
or workflow. No baseline was copied or generated for adoption. Corrected Linux
Admin generation, human review, and the unchanged full final PR checks remain
required release steps. No workflow, branch protection, provider setting,
Auth/session behavior, hosted data or database migration changed.

Local diagnostic logs are in the parent visualization directory:
`admin-gutter-before-2026-09-20.log`, `admin-gutter-after-2026-09-20.log`,
`admin-gutter-preview-2026-09-20.log`, and `admin-gutter-unit-2026-09-20.log`.
