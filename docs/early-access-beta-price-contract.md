# Early-access beta price contract (not activated)

`supabase/functions/_shared/early_access_price.ts` is a pure, server-only
preconfiguration contract for **USD $3.50 per month**. It makes no database,
Auth, Stripe, or network calls. It is not imported by Checkout or webhook code,
does not create a price or subscription, and does not enable billing.
`BILLING_ENABLED=false` remains required by the current production release.

## Input and result

`selectMembershipPrice(input)` receives a verified Auth `expectedUserId`, an
exact canonical database result `{ user_id, eligible }`, the existing
`standardPriceId`, and separate server-owned `earlyAccessPriceId`,
`expectedProductId`, `expectedLivemode`, and `retrievedEarlyAccessPrice` inputs.
It returns a frozen `{ kind: "standard" | "early_access", priceId }`.

The caller must perform a successful database lookup with current session and
account-lifecycle enforcement. The helper checks the response shape and owner
binding; those checks do **not** prove a value came from the database. Never pass
request-body flags, email allowlists, Auth/user metadata, client-supplied prices,
or a guessed `false` on lookup failure. Missing/malformed/mismatched eligibility
stops selection, even on the standard-price path.

Canonically ineligible members retain their configured standard-price path,
without requiring early-access pricing configuration. When both price IDs are
configured, they must differ: a collision stops either selection rather than
exposing the grandfathered price through the standard path. Eligible members never
silently fall back to standard pricing. Their server-fetched Stripe Price must
match the exact configured price ID, product ID, and test/live mode; be active;
and use licensed, fixed-per-unit, monthly USD 350-cent pricing at interval 1.
Custom amounts, tiers, quantity transforms, metering, default trial periods,
different decimal amounts, and alternate currencies are rejected.

Retrieve the Price server-side with `expand[]=currency_options`; omitted options
are rejected because omission does not prove that alternatives are absent. A
`null` option map or a validated USD-only map is supported. Leave `product`
unexpanded: this contract requires the exact configured product ID string.
Nullable fixed-price fields must be present as returned by Stripe. See the
[Stripe Price object](https://docs.stripe.com/api/prices/object) and
[Price retrieval API](https://docs.stripe.com/api/prices/retrieve).

`EarlyAccessPriceError` exposes only a safe error code and a generic message.
The caller must map failures to checkout-unavailable without logging identities,
provider payloads, or secrets. This is not a charge calculation or final total;
tax, discounts, subscription state, and Checkout behavior require separate review.

## Required before activation

- Resolve early-access duration and grandfathering/cancellation/returner policy.
  Implement durable canonical eligibility and an auditable operator workflow;
  this helper deliberately does not decide those policies.
- Create and verify the approved Stripe product/price in the intended mode and
  configure their IDs server-side. No environment-variable names or secret
  requirements are added to current deployments by this isolated helper.
- Wire and test authenticated eligibility lookup, server-side Price retrieval,
  failure handling, Checkout, webhook reconciliation, and customer-facing price
  disclosure. Enforce exactly one unit and USD at Checkout; review any promotion,
  trial, tax, or currency-conversion settings before promising a final amount.
- Verify product lifecycle and current price configuration at the provider
  boundary; a pure snapshot validator cannot prevent later Stripe changes.
- Obtain separate billing-launch approval before changing billing flags or
  charging anyone. These files do not complete an early-access/billing ticket.

Pure verification (no network or environment permissions):

```sh
cd supabase
deno test --frozen functions/_shared/early_access_price_test.ts
deno check --frozen functions/_shared/early_access_price_test.ts
```
