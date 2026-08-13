# Account lifecycle and policy release gate

FOU-761 adds a member-facing password recovery flow, stable policy/support
routes, and a tracked intake for account data-export and deletion requests. The
code is ready to deploy to a non-production environment, but deploying it does
not satisfy the external launch gates below.

## Account request boundary

`public.account_lifecycle_requests` accepts only `data_export` and
`account_deletion`. An authenticated member can insert the request type with
their own user ID and read only their own rows. They cannot provide a status,
operator note, timestamp, or outcome, and they cannot update or delete request
history. A partial unique index makes retries return the existing active request
instead of creating duplicate work.

Only the service role can move a request through `requested`, `in_progress`, and
a terminal status. Keep notes member-safe; never store exported data, secrets,
raw object paths, or private operational evidence in this public table. The
account-deletion request is an intake record, not permission for an automated
purge. Fulfillment must use the reviewed production deletion runbook, verified
backup, and operator approvals. When Auth deletion completes, the table removes
the live user reference but keeps the non-identifying outcome row.

## Required checks before production

- Owner or qualified counsel approves `privacy.html`, `terms.html`, and
  `cancellation-refunds.html`. They are behavior-based drafts, not legal advice.
- `support@77dominion.com` is provisioned, monitored, and tested from an external
  mailbox. Update the page before launch if a different address is chosen.
- Production Supabase Auth Site URL is the exact production origin, and its
  redirect allowlist includes only the exact production `reset-password.html`
  path. Localhost stays in local Supabase; the hosted tenant does not allow
  `develop` or feature-preview callbacks.
- Custom SMTP sender, SPF, DKIM, DMARC, rate limits, and inbox/spam delivery are
  verified. Do not claim password recovery is launch-ready from local tests.
- Run one real valid-link recovery, one expired-link recovery, and one reused-link
  recovery during the closed production canary. Confirm a successful password
  change signs out the recovery session and requires a fresh login.
- Exercise one export and one deletion request with two different accounts.
  Confirm RLS blocks cross-account reads and writes, the duplicate submit is
  idempotent, an operator can update status, and the member sees the outcome.
- Document the export delivery channel, deletion fulfillment owner, response
  target, escalation path, and evidence-retention period in the release record.
