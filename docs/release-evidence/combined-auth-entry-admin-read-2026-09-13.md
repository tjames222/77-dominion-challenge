# Combined backlog: authentication-entry Admin-read race

This local checkpoint is based on `e6da1e673c1e7c0a5832a556c34fa252e54944ed`.
It does not change the separate MFA release, Supabase configuration, SQL,
provider fixture acceptance, production data, or deployment workflows.

## Observed failure and diagnosis

Linux run `34792040304` failed the WebKit shared-menu logout-outage test with
an access-control diagnostic naming `get_site_admin_context`. The exact failed
MFA trace is in artifact `browser-quality-1` (artifact ID `10327594071`), file
`data/69eaf8211e1cbee02b600aa72acf0ea55a07be15.zip`.

The diagnostic occurred at trace time **33223.506 ms**, during **Login →
Support**, before the first logout request at **36376.804 ms**. No corresponding
Login Admin request reached the trace's network record. The later two Support
Admin requests were same-origin and returned HTTP 200. The failed logout
returned the fixture's intended 503; the explicit retry returned 200.

Eight instrumented local WebKit runs of the unchanged application all started
an Admin readiness fetch on Login just before navigation. Two reported that
request as cancelled. None produced a local `pageerror`, `window.error`, or
`unhandledrejection`: the exact Linux engine diagnostic was **not** reproduced
locally. The trace and local observations demonstrate the unnecessary departing
Login read; they do not establish a provider CORS configuration fault.

The source path is a deferred shared-menu rebuild after `SIGNED_IN`, racing
Login's immediate continuation navigation. The fetch and its callers already
await/catch failures. Playwright's WebKit adapter can classify a JavaScript
console diagnostic as `pageerror`; it is not by itself proof of an unhandled
application promise.

## Bounded change

The shared menu omits optional Admin readiness on exact normalized Login,
Register, Forgot Password, Reset Password, and Account Security routes. The
guard runs before any asynchronous identity or readiness work. Clean paths,
HTML paths, and trailing slashes use the existing route normalizer. Near-miss
route names and query/fragment contents do not affect admission.

Support, Admin, and other allowed routes retain the existing canonical
actor/session/MFA/capability checks. This is not a role grant, a readiness cache,
or an authentication bypass. Account Security still loads no shared menu.

## Local verification

- New authenticated Login load/menu-open/refocus regression first failed on
  the unchanged app, observing two AAL1 Admin requests.
- `pnpm test`: **924 passed**.
- Production-built synthetic MFA Chromium/WebKit suite, port 4467:
  **40 passed**, including all four menu-bearing authentication-entry routes,
  existing Account Security isolation, and positive Support readiness.
- The exact navigation/logout test was rerun in both engines after adding the
  positive observer assertion: **2 passed**. Each recorded zero Login Admin
  fetches, two Support Admin fetches, and zero request failures, page errors,
  window errors, or unhandled rejections.
- Production-built synthetic Admin Chromium/WebKit suite, port 4468:
  **78 passed**; canonical readiness, read-only panels, deny-only queue,
  session invalidation, and four-theme coverage remain intact.
- Independent read-only review found no issue in route admission; six focused
  normalized-route tests passed in that review.

The tests retain every existing `pageErrors` assertion. The navigation test
adds initiating-document and window-event evidence without changing the fetch
promise or preventing browser error events. No CORS headers or Auth fixture
acceptance were changed.

**Still pending:** integration and exact-head Linux verification. Local results
do not certify a successful Linux rerun or a production deployment.
