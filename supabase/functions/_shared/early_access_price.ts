/**
 * Server-only, side-effect-free preconfiguration contract. This is not an
 * authorization boundary: eligibility must come from the canonical database,
 * after authenticating the owner and enforcing the current session/lifecycle.
 * Never supply a request body, JWT/user metadata, or a browser-provided Price.
 */
export const EARLY_ACCESS_BETA_PRICE = Object.freeze(
  {
    currency: "usd",
    unitAmount: 350,
    interval: "month",
    intervalCount: 1,
    quantity: 1,
  } as const,
);

export type MembershipPriceSelection = Readonly<{
  kind: "standard" | "early_access";
  priceId: string;
}>;

export type MembershipPriceInput = Readonly<{
  /** Verified Auth user ID; never an unchecked request parameter. */
  expectedUserId: string;
  /** Exact canonical database result: { user_id: string, eligible: boolean }. */
  eligibility: unknown;
  /** Existing normal membership price configuration. */
  standardPriceId?: string;
  /** Separate server/operator configuration, not a caller-selected price. */
  earlyAccessPriceId?: string;
  expectedProductId?: string;
  expectedLivemode: boolean;
  /** Server-retrieved Stripe Price, with currency_options explicitly expanded. */
  retrievedEarlyAccessPrice?: unknown;
}>;

export type EarlyAccessPriceErrorCode =
  | "eligibility_unavailable"
  | "eligibility_owner_mismatch"
  | "price_configuration_collision"
  | "standard_price_unavailable"
  | "early_access_price_unavailable"
  | "early_access_price_invalid";

export class EarlyAccessPriceError extends Error {
  constructor(readonly code: EarlyAccessPriceErrorCode) {
    // Safe to translate into a generic checkout-unavailable response. Never
    // include identity, provider payloads, or configuration in this message.
    super("Membership pricing is unavailable.");
    this.name = "EarlyAccessPriceError";
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuredId(
  value: unknown,
  prefix: "price" | "prod",
): value is string {
  return typeof value === "string" && value.length <= 255 &&
    new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
}

function fixedAmount(value: Record<string, unknown>) {
  return value.unit_amount === EARLY_ACCESS_BETA_PRICE.unitAmount &&
    typeof value.unit_amount_decimal === "string" &&
    /^350(?:\.0{1,12})?$/.test(value.unit_amount_decimal) &&
    value.custom_unit_amount === null &&
    (value.tiers === undefined || value.tiers === null);
}

function fixedCurrencyOptions(price: Record<string, unknown>) {
  // Stripe omits this includable field unless it is explicitly expanded. An
  // omitted field is not evidence that a multi-currency option does not exist.
  if (!Object.hasOwn(price, "currency_options")) return false;
  const options = price.currency_options;
  if (options === null) return true;
  if (!record(options)) return false;
  const currencies = Object.keys(options);
  return currencies.length === 1 && currencies[0] === "usd" &&
    record(options.usd) && fixedAmount(options.usd);
}

function validateEarlyAccessPrice(input: MembershipPriceInput): string {
  const priceId = input.earlyAccessPriceId;
  if (
    !configuredId(priceId, "price") ||
    !configuredId(input.expectedProductId, "prod") ||
    input.retrievedEarlyAccessPrice === undefined ||
    input.retrievedEarlyAccessPrice === null
  ) {
    throw new EarlyAccessPriceError("early_access_price_unavailable");
  }

  const price = input.retrievedEarlyAccessPrice;
  if (
    !record(price) || price.object !== "price" || price.id !== priceId ||
    price.active !== true || price.deleted !== undefined ||
    price.product !== input.expectedProductId ||
    typeof input.expectedLivemode !== "boolean" ||
    price.livemode !== input.expectedLivemode ||
    price.currency !== EARLY_ACCESS_BETA_PRICE.currency ||
    price.type !== "recurring" || price.billing_scheme !== "per_unit" ||
    !fixedAmount(price) || price.tiers_mode !== null ||
    price.transform_quantity !== null || !fixedCurrencyOptions(price) ||
    !record(price.recurring) ||
    price.recurring.interval !== EARLY_ACCESS_BETA_PRICE.interval ||
    price.recurring.interval_count !== EARLY_ACCESS_BETA_PRICE.intervalCount ||
    price.recurring.usage_type !== "licensed" ||
    price.recurring.trial_period_days !== null ||
    (price.recurring.meter !== undefined && price.recurring.meter !== null)
  ) {
    throw new EarlyAccessPriceError("early_access_price_invalid");
  }
  return priceId;
}

/**
 * Select only after a successful canonical eligibility lookup. Lookup failure,
 * malformed/mismatched authority, or invalid eligible-member configuration must
 * stop checkout; none may silently fall back to the normal membership price.
 * This function neither defines eligibility policy nor enables billing.
 */
export function selectMembershipPrice(
  input: MembershipPriceInput,
): MembershipPriceSelection {
  const eligibility = input.eligibility;
  if (
    typeof input.expectedUserId !== "string" ||
    !uuidPattern.test(input.expectedUserId) || !record(eligibility) ||
    Object.keys(eligibility).length !== 2 ||
    !Object.hasOwn(eligibility, "user_id") ||
    !Object.hasOwn(eligibility, "eligible") ||
    typeof eligibility.user_id !== "string" ||
    !uuidPattern.test(eligibility.user_id) ||
    typeof eligibility.eligible !== "boolean"
  ) {
    throw new EarlyAccessPriceError("eligibility_unavailable");
  }
  if (eligibility.user_id !== input.expectedUserId) {
    throw new EarlyAccessPriceError("eligibility_owner_mismatch");
  }
  if (
    typeof input.standardPriceId === "string" && input.standardPriceId &&
    input.standardPriceId === input.earlyAccessPriceId
  ) {
    throw new EarlyAccessPriceError("price_configuration_collision");
  }
  if (eligibility.eligible) {
    return Object.freeze({
      kind: "early_access",
      priceId: validateEarlyAccessPrice(input),
    });
  }
  if (
    typeof input.standardPriceId !== "string" || !input.standardPriceId
  ) {
    throw new EarlyAccessPriceError("standard_price_unavailable");
  }
  // Preserve the existing configured standard-price path for canonically
  // ineligible members; it does not depend on grandfathered-price setup.
  return Object.freeze({ kind: "standard", priceId: input.standardPriceId });
}
