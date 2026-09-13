# Early-access request intake (FOU-1741)

`Get Early Access` opens the request section on Membership. Visitors provide a
name and email; signed-in users receive account prefills and must use their
verified account email. Loading prevents repeat clicks, failure preserves the
form, and account changes clear the preceding account's details. The form is
hidden until its handler and identity check are ready, with a POST-only fallback
and a no-JavaScript explanation so personal details cannot enter a GET URL.

This is **intake only**. It does not create accounts, send emails/invitations,
approve requests, grant membership, enable public signup, or enable billing.
Review and invitation operations belong to FOU-1742.

## Storage and authorization

- `private.early_access_requests` stores normalized name/email, optional verified
  Auth user ID, status, timestamps, form version, and an initially empty answers
  object for future questions. Public API callers cannot supply status or answers.
- The email is unique across request states; a partial unique index also allows
  only one pending request per known account. Repeats do not overwrite names,
  review status, or existing identity. A verified matching email may associate a
  previously anonymous request with its account.
- Both request and intake-attempt tables have RLS and no browser-role grants.
  `submit_early_access_request_service` is INVOKER, has an empty search path,
  and is executable only by the service role. The intake service can associate
  identity but cannot insert or update status. No browser can enumerate the review queue.
- `request-early-access` is publicly callable (`verify_jwt=false`) for visitors.
  When an Authorization header is present, it must pass the existing server-side
  `getUser` verification; invalid credentials never downgrade to an anonymous
  request. SQL rechecks the verified account/email before persistence.
- An origin allowlist, honeypot, 2 KiB body limit, five-second body deadline, and
  atomic global limit of 20 accepted intake attempts/minute and 100/hour keep the
  free launch path bounded. Duplicates consume the same budget **before** lookup
  so capacity responses do not reveal existing emails. PII-free attempt records
  older than one hour are reclaimed during successful intake. Concurrent writes
  serialize under one transaction advisory lock with a five-second lock timeout.
- New and existing requests receive only `{ "received": true }`; no ID, status,
  email, or account metadata is returned. Responses are `private, no-store`.

The global budget protects storage growth but is not a CAPTCHA or per-person
abuse guarantee: a determined sender can exhaust a shared window. A future
reviewed Turnstile configuration can improve availability without changing the
private persistence contract. Do not trust client-supplied forwarding/IP headers.

## Develop and privacy

Mock previews keep the request form available even though the billing/signup
preview is also enabled. They save only a browser-local hashed-email receipt,
pending marker, and timestamp; no real request or email is sent. Raw form inputs
are not saved in browser storage. Production stores the submitted request in the
private database. The Privacy page describes this distinction and the Support
path for corrections/deletion, including for people without an account.

## Deployment and checks

The existing protected backend workflow applies the append-only migration,
deploys `request-early-access --no-verify-jwt` to the existing Supabase project,
then runs `scripts/verify-production-early-access.mjs`. The smoke sends only an
empty JSON object: allowed production origins must return 400 and a disallowed
origin 403, with origin-bound CORS and `private, no-store`. It never creates a
request and never sends a user token or API key. Deploy the backend before the
frontend so the new form does not point at a missing endpoint.

Validation is registered in the frontend tests, Deno check/test, the canonical
pgTAP suite, and `pnpm run test:early-access-sql`. The latter creates only a
random-name, network-disabled, tmpfs-only Postgres 17.6.1.141 fixture, tests the
exact migration including concurrency, and removes only its own container.
Browser coverage runs in Chromium and mobile Safari/WebKit.

Local development verification used that isolated fixture because the exact
77 Dominion Supabase stack was not running. `supabase db advisors --local` could
not connect; full-stack advisor, migration-history, and schema-drift validation
must run in the existing clean CI stack. No unrelated container or hosted
database is an acceptable substitute. The migration filename was created with
the CLI and its verified SQL included by the canonical `supabase/schema.sql`.
