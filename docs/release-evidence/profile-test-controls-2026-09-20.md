# Profile testing-control removal

FOU-1502 requires that members cannot enable testing from Profile. The shared
document now contains no 77-day simulation switch or reset control in any mode.
Profile's simulator imports, rendering, event handlers, and storage writes and
the controls' unused CSS are removed. This does not implement server testing
grants, a test clock, or any admin activation.

The existing synthetic simulator domain fixtures remain unchanged for automated
tests. Production dates, entitlements, MFA, Profile themes, and account controls
are unchanged. No hosted data or testing grant was modified.

## Verification

- Integrated 940 unit tests pass.
- Eight local Profile checks cover four themes at phone and desktop widths.
- Seven hybrid-auth checks pass, including owner-scoped synthetic-state
  preservation and absence of testing controls.
- All 44 production-built MFA/Profile checks pass in Chromium and WebKit.
- The new Profile check also passed five repeats in each engine.
- Exact final Linux baselines remain required; no macOS baseline is substituted.

The first integrated WebKit run exposed an unrelated setup-navigation race:
the test logged into Support and forced another navigation about 40 ms after
Support loaded. Two WebKit diagnostics occurred at 14588.509/14589.240 ms,
before Profile's JavaScript began fetching at 14591.300 ms. Profile's first Auth
request began at 14656.282 ms and all recorded Profile Auth responses were 200.
Independent trace review confirmed this ordering.

The bounded controls test now uses the normal direct Login-to-Profile
continuation, with only its synthetic legacy flag seeded by a Profile-only init
script before Profile starts. All page-error, no-controls, and unchanged-storage
assertions remain. No provider acceptance, CORS setting, runtime error filtering,
or application behavior was changed to accommodate the test. This correction
does not claim general rapid-navigation teardown behavior has been validated.
