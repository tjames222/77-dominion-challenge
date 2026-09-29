# Release ownership and solo-maintainer decision

## Approved decision — September 28, 2026

For FOU-758, Tim James explicitly accepted the existing solo-maintainer release
model: required automated checks and production-owner approval remain mandatory,
but a second human reviewer is not required. This records an ownership and risk
decision; it does not change GitHub settings, grant a bypass, or claim an
independent human review occurred.

| Responsibility | Accountable owner | Operational destination |
| --- | --- | --- |
| Production incident triage, containment, and recovery approval | Tim James (`tjames222`) | `tjames@cablueprinting.com` |
| Secret inventory, exposure response, and coordinated rotation | Tim James (`tjames222`) | `tjames@cablueprinting.com` |
| Profile-photo cleanup alert receipt and investigation | Tim James (`tjames222`) | `tjames@cablueprinting.com` |

The role labels in the backend secret inventory identify the provider or security
responsibility, not additional appointed people. Tim James is accountable for
those responsibilities, including the active Early Access invitation, feedback,
Resend, and Linear credentials documented in their runtime runbooks. Deferred
provider credentials remain deferred; this decision does not enable billing or
provider integrations, create credentials, or authorize arbitrary rotations.
No secondary on-call owner or continuous-response service is currently appointed.

## Existing enforcement retained

Read-only GitHub verification on September 28, 2026 confirmed the following for
both `main` and `develop`:

- Pull requests must have the current, up-to-date required checks: `Frontend`,
  `Database`, `Edge Functions`, and `Routes, accessibility, and visuals`.
- Branch protections apply to administrators. Force pushes and branch deletion
  are disabled, and review conversations must be resolved.
- The required approving-review count is zero; stale reviews are dismissed.
  Code-owner review and approval of the last push are not additional gates.

The GitHub `production` environment permits only the `main` branch and requires
approval by `tjames222`. Its existing setting permits self-review. Tim accepts
that the same maintainer may author the change and approve its production
deployment; the four required checks, exact-commit release evidence, protected
environment, and documented rollback boundaries remain in force. Do not count
only the checks already visible while a browser aggregate is still pending.

If a check or production gate fails, stop and follow the
[backend release runbook](backend-release-runbook.md). This decision does not
authorize weakening checks, disabling protections, overriding a failed gate,
changing projects, or exposing production credentials to previews. Any change
to the review model or appointed owners requires a new recorded decision.

## Incident and rotation handoff

Use `tjames@cablueprinting.com` for operational escalation. Record the affected
service, fixed error or threshold code, UTC observation time, release/run link,
and recovery status; do not include credentials, invitation links, member data,
or photo paths. Preserve evidence and use the runbook's compatible rollback or
forward-fix path. Destructive recovery still requires explicit data-loss approval.

For a confirmed credential exposure or approved rotation, Tim coordinates the
provider, protected GitHub environment, deployed runtime, and any Vault consumer
as one reviewed operation. Verify the replacement before retiring the old value
where the provider supports overlap; preserve encryption-key versions needed by
queued ciphertext. Never print or copy an existing production secret into a
preview or monitoring environment.

Naming an owner and destination does not install an alert. FOU-802 remains open
until the cleanup thresholds, durable deduplication/recovery behavior, actual
notification transport, and a received test alert are verified. See the
[cleanup runbook](profile-photo-cleanup-runbook.md#health-and-alerting). Likewise,
the missing independent `cloudflare-preview` credential is a separate FOU-760
implementation item, not a reason to reuse the production token.
