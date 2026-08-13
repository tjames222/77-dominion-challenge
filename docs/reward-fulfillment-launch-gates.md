# Reward fulfillment launch gates

The consolidated reward catalog can ship before external fulfillment is ready.
Permanent ownership still grants at the configured threshold, but partner,
merchandise, and handbook actions must stay unavailable until every applicable
gate below is satisfied. Preview fixtures are test-only and must never be copied
into production configuration.

## Safe default

- `gym_training_discount` and `big_god_energy_tshirt_discount` start with an
  inactive `production-pending` configuration containing no partner, offer,
  destination, or code.
- `nehemiah_leadership_handbook` has no active asset record and its bucket is
  private.
- An eligible member still receives permanent ownership. The detail dialog says
  fulfillment is being finalized and offers no claim, visit, or download action.
- Never invent production codes, URLs, partner names, expiration dates, terms,
  handbook content, or approval records. Never put code inventory in source,
  Linear, browser storage, logs, catalog metadata, or client-readable tables.

## Gym Training Discount

Before activation, obtain and approve:

- legal partner name, approved HTTPS website and redemption destinations, offer
  title/description, and any licensed logo plus meaningful alt text;
- exact discount or benefit, qualifying purchase, usage limit, campaign start
  and end, customer-facing expiration copy, exclusions, and full terms;
- fulfillment method (`unique_code`, approved shared-code workflow, or provider),
  sufficient inventory/provider capacity, expiry behavior, exhaustion behavior,
  and partner redemption test evidence;
- brand/legal approval for the partner relationship and final customer copy.

Load those values using service-only deployment tooling, verify one eligible
member can claim exactly once and another cannot see that claim, then mark the
configuration `active` and `is_active = true` in the same controlled release.

## Big God Energy T-Shirt Discount

The catalog image must remain the approved original at
`public/images/big-god-energy-tshirt.jpg` with alt text “Black Big God Energy
T-shirt with white lettering.” Before activating fulfillment, obtain and approve:

- the production HTTPS product/redemption destination and commerce owner;
- exact offer, eligible product/variants, exclusions, inventory behavior,
  geographic limits, start/end dates, expiration copy, usage limit, and terms;
- unique production code inventory or an approved provider integration, including
  sufficient capacity and an end-to-end checkout redemption test;
- merchandise artwork/product rights and final brand/legal approval.

Keep the offer inactive if the product, a required size, codes, or checkout route
is unavailable. The ownership remains visible and permanent.

## Nehemiah Leadership Handbook

Before any asset becomes active, obtain and approve:

- the final PDF, public title/description, edition key, version, and download
  filename;
- authorship/distribution rights, theological/content review, and final product
  approval;
- accessible PDF review, including reading order, tagged headings, link labels,
  image alt text, document language/title, keyboard behavior, and sufficient
  contrast;
- malware scan, exact lowercase SHA-256 checksum, byte size at or below 50 MiB,
  and an end-to-end verified-byte download test.

Upload only the approved file to the private `reward-downloads` bucket. Create a
service-only asset record whose path matches the uploaded object and whose
checksum and size match the file. Set `is_approved`, `approved_at`, and
`is_active` only after review evidence is recorded. Do not expose the storage
path or use a public bucket.

The download Edge Function must authorize the current actor, redeem a one-time
ticket, download the private object once, verify that exact byte buffer against
the approved size, PDF signature, MIME type, and SHA-256 checksum, then return
those same bytes with attachment and no-store headers. It must not return a
signed URL or expose the bucket/object path.

## Production verification

For each fulfillment activation, verify locked, owned-but-unavailable, active,
expired/exhausted, repeat-claim, cross-account isolation, keyboard/focus, mobile,
and request-failure states. Confirm the configured public gym website is visible
while locked but redemption destinations and codes remain gated until
ownership/claim. Confirm the catalog and metadata endpoints redact codes and
private storage fields, download responses contain only the verified approved
bytes and public filename, audit events contain no secrets, and disabling a configuration
removes its action without deleting entitlement or claim history.
