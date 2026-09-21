# Shared Auth runtime core, stage 1 — 2026-09-20

Base: `1f0e447da83e1660806e0f808b045abcab1e0685`. This is isolated third-batch work on `epic/auth-runtime-core-2026-09-20`, not a change to either active release worktree. No push, deployment, hosted query, permission, policy, migration, or provider setting was changed.

## Mechanical boundary

`auth-runtime-core.mjs` now owns the existing environment configuration, single guarded Supabase client, MFA adapter, mode predicates, in-flight presentation-read singleton, preview ownership epoch, and synchronous Auth/storage/online/offline/visibility fences. It imports only the existing SDK and four low-level Auth/read-state modules; it does not import `api.js` or a feature controller.

`api.js` imports that core and preserves its four public compatibility exports by identity: `supabase`, `cancelMfaOperations`, `getMfaAuthAdapter`, and `isLocalDemoMode`. The preview epoch remains a live ES-module binding; its two former external increments call a synchronous helper at exactly the same positions. The mutation invalidator still executes before the operation and in `finally`.

All other Auth and application functions remain in the facade: canonical checks, Login resume and MFA routing, profile establishment, logout reservation/confirmed-provider-error behavior, theme preference/ownership checks, caller cancellation, Admin/Daily invalidation listeners, and member APIs. No Auth results are cached, no verification is delayed, and no new asynchronous boundary is introduced.

## Initialization and graph review

The first draft imported the core after the domain imports. The existing actual-build regression correctly failed: Vite grouped a shared dependency with `dialog.mjs`, adding it to Account Security's initial graph. That draft was not accepted. Making the actual low-level core the first dependency restores the original feature dependency sets without changing Vite configuration, grouping thresholds, preload policy, or adding artificial imports/code.

Independent read-only review recursively parsed the 42 local static modules reachable from the API facade. The dependencies whose evaluation moves relative to the core initialize only literals, collections/frozen catalogs, or pure environment-based release gates. They perform no Auth calls, browser/storage mutation, listener registration, or top-level await. A programmatic comparison also found the extracted body equal to the original after accounting for export keywords, the API-only E2E predicate, and the synchronous epoch helper.

The new compiled-module test imports both the actual facade and core. Only the provider constructor is substituted; the guard, MFA adapter, in-flight read state, and observers are real. It proves one client and this registration order:

1. Guard storage/pagehide listeners, then the configured SDK constructor.
2. Guard Auth observer, MFA adapter observer, then the synchronous in-flight/preview observer.
3. Existing core storage/network/challenge/visibility listeners.
4. Existing API Admin and Daily pagehide/storage listeners.

Additional assertions prove that the identity fence completes before a UI Auth observer, rejects an old in-flight result, shares the live epoch, preserves guarded fetch/storage and SDK persistence settings, and performs no canonical Auth/network call during module initialization or notification. Every existing entry's actual build graph now also asserts exactly one core module. No existing graph exclusion was removed.

## Paired canonical builds

Two before/after pairs use the unchanged production Vite configuration and canonical Cloudflare environment normalization. The before build substitutes only the exact base `api.js`; the new core is unreachable in that baseline. All 28 emitted HTML graphs are traversed through static chunk imports, including public bootstrap assets. Main uses a synthetic publishable key only for compilation, with no provider call.

For **all 28 routes in both develop and main**:

- Initial request counts are identical.
- CSS gzip bytes and every CSS SHA-256 are identical.
- Initial module inventories are identical after excluding the newly extracted core itself.
- Initial gzip JavaScript decreases slightly: **457–508 bytes on develop**, **401–457 bytes on main**.

| Route | Develop JS before → after | Main JS before → after |
| --- | ---: | ---: |
| Landing | 135,605 → 135,127 B | 135,699 → 135,276 B |
| Login | 138,926 → 138,449 B | 139,020 → 138,599 B |
| Dashboard | 154,615 → 154,107 B | 154,710 → 154,253 B |
| Badges | 146,711 → 146,236 B | 146,805 → 146,385 B |
| Community | 161,019 → 160,530 B | 161,114 → 160,679 B |
| Profile | 141,407 → 140,926 B | 141,501 → 141,074 B |
| Account Security | 122,187 → 121,730 B | 122,279 → 121,878 B |

This is an architectural prerequisite, not completion of FOU-1501's public/member reduction targets. The member API graph is still shared; no performance budget or completion target changed.

## Verification

- Frozen lockfile dependencies; Node **26.4.0**, pnpm **10.17.1**, Vite **8.1.5**, macOS arm64. Lockfile SHA-256 remains `49b9f4808756b782d9b3e5a147a945c46151ed1bd080c786d83d419dff26eb13`.
- Full unit suite: **1,021 passed**, no failures/skips. Includes the four compiled-module tests, existing real-SDK sign-out/outage tests, delayed optional-theme success/cancellation tests, preview epoch tests, and actual 28-entry build-contract tests.
- Production-built real-SDK MFA: **44 passed**, Chromium and WebKit.
- Local real-SDK hybrid Auth/logout: **7 passed**, including existing cancellation/error assertions without suppression.
- Production-built Admin: **140 passed**, Chromium and WebKit, including role controls in the separate next batch.
- Production-built Daily Action: **66 passed**, Chromium and WebKit.
- Built-preview and hybrid badge ownership: **28 passed**, Chromium and WebKit.
- Normal `pnpm run build` with environment and emitted asset verification passed for canonical develop and main configurations.
- Independent final review: no actionable findings; **54 focused tests passed**, none failed/skipped.
- `git diff --check` passed. No CSS, HTML, workflow, budget, migration, dependency, or lockfile changes.

Private generated evidence is retained in the isolated worktree's ignored `test-results/auth-runtime-evidence/`: the reproducible paired-build `audit.mjs`, both `graph-*.json` reports with exact source hashes and complete route/module inventories, summaries, normal build logs, final units, initial rejected-draft unit log, and all five browser suite logs. These are local synthetic/build results, not hosted production or final Linux visual approval.

The Supabase skill informed the one-client, explicit-guard, synchronous-observer constraints. Current documentation confirms that Auth callbacks should remain synchronous and that making async SDK calls inside them can deadlock: [Auth notifications](https://supabase.com/docs/reference/javascript/auth-onauthstatechange), [callback deadlock guidance](https://supabase.com/docs/guides/troubleshooting/why-is-my-supabase-api-call-not-returning-PGzXw0). The current changelog introduced no client change needed by this extraction.
