# Optional Auth-entry theme lifecycle checkpoint

Base: `89ccd1c4e163a2d074bec135e837834cf4058dfa`. This checkpoint changes local client lifecycle ownership and synthetic tests only. It does not change SQL, grants, reward rules, billing, release flags, hosted configuration, or production data.

## Diagnosed boundary

The earlier exact-head Linux generation `34793565244` passed 38 of 40 MFA checks. Its two WebKit failures reported `/auth/v1/user` access-control diagnostics during the initial Login-to-Support navigation, before the tested recovery-page navigation. Prior trace attribution identified optional menu theme hydration: `get_reward_catalog` / `get_theme_preference` completed as Login navigated, and their canonical post-RPC user checks raced the departing document. The previously fixed optional Admin readiness request was absent on Login. This is not a reason to relax canonical Auth validation or CORS handling.

## Ownership changes

- A document-local reservation pauses only menu-owned optional theme hydration before Login/Register calls the Auth SDK. Queued work rechecks its captured generation. Failed or no-session attempts resume a new generation; committed navigation stays paused. Old form completions cannot release a newer reservation. Page hide cancels the departing optional generation; persisted restoration starts a fresh one.
- Explicit Login session/MFA/profile validation remains awaited and unchanged. Auth observers schedule work outside the callback; the reservation does not confer authority, store private payloads, or memoize Auth.
- `getRewardCatalog`, `getThemePreference`, and `setThemePreference` gain an optional `signal` option. Non-cancelled callers retain canonical pre- and post-RPC `requireUser` checks. Aborted callers are fenced before new requests and after awaits; their RPC carries only their signal. A cancelled optional consumer cannot cancel another consumer's request or invalidate the actor-wide hydration epoch.
- Unsignalled direct callers retain the same-actor cache. Optional callers use a separate per-signal cache. A direct pending or completed owner controls the protected-theme gate, entitlements, theme publication, and missing-preference migration. A late optional success can return its verified result but cannot overwrite direct state or initiate a fallback write once the direct owner exists. An already-sent preference write cannot be retroactively undone by client cancellation.
- This isolation can issue an additional catalog/preference pair when optional and direct consumers coexist. Same-owner coalescing and the unsignalled cache are preserved. This checkpoint makes no request-count or performance improvement claim.

## Verification on the final source

Frozen lockfile installation used Supabase JS 2.110.0 and Playwright 1.61.1. No dependency or lockfile changes.

| Gate | Result |
| --- | --- |
| `pnpm test` | 939 passed, 0 failed |
| `node --test src/static/auth-entry-transition.test.mjs` | 13 passed |
| `playwright.mfa.config.mjs` | 42 passed; production-built Chromium desktop and WebKit phone |
| `playwright.admin.config.mjs` | 78 passed; production-built Chromium and WebKit |
| `playwright.fou-1452.config.mjs` | 6 passed; hybrid Vite development fixture, not a production-build assertion |
| `git diff --check` | Passed |

The focused unit fixtures execute the actual API/theme module source. They cover cancelled delayed requests beside an unaffected direct consumer, exact canonical check counts, reservation ownership/retry, direct entitlement and pending-gate preservation, and four late-success cases (pending/completed direct owner crossed with present/missing optional preference). All four added late-success cases failed against the recovered pre-fix source, then passed with the ownership admission guards. Login and Register form fixtures cover failure, no-session completion, retry, and navigation commitment.

The SDK-backed browser regression holds explicit Login profile validation, proves no optional theme RPC starts during that attempt, preserves required user validation, returns a synthetic non-transient 403, waits for the resumed theme response, and retries into Support. A 503 was unsuitable because the installed SDK transparently retried it into success. Same-route authenticated theme hydration remains tested. Browser error and unhandled-rejection assertions are unchanged; fetch instrumentation returns the original promise. No error suppression, Auth acceptance broadening, or CORS fixture change was added. The hybrid suite includes intentional outage diagnostics; its pass result is not a claim that every synthetic console line is empty.

Durable local evidence is in the sibling `backlog-resume-evidence-2026-09-20` directory: `unit.log`, `mfa.log`, `mfa-report/index.html`, `admin.log`, `hybrid.log`, `theme-owner-before-fix.log`, and `theme-owner-after-fix.log`. Generated Admin screenshots remain in this durable worktree's ignored `test-results/admin-live` directory.

An independent read-only review identified and then verified the successful-response publication/migration ownership correction. No remaining source blocker was reported. Linux generation, reviewed baseline acceptance, final combined CI, and deployment remain root-owned subsequent gates; no fresh Linux pass or deployment is claimed here.

Current official references checked: [Auth event callback guidance](https://supabase.com/docs/reference/javascript/auth-onauthstatechange) and [caller-provided query AbortSignal](https://supabase.com/docs/reference/javascript/using-modifiers-abortsignal).
