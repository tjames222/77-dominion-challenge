import { assert, assertEquals } from "./test_helpers.ts";
import {
  EARLY_ACCESS_BETA_PRICE,
  EarlyAccessPriceError,
  type EarlyAccessPriceErrorCode,
  type MembershipPriceInput,
  selectMembershipPrice,
} from "./early_access_price.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";

function price(): Record<string, unknown> {
  return {
    id: "price_early350",
    object: "price",
    active: true,
    product: "prod_membership",
    livemode: false,
    currency: "usd",
    currency_options: null,
    billing_scheme: "per_unit",
    custom_unit_amount: null,
    recurring: {
      interval: "month",
      interval_count: 1,
      trial_period_days: null,
      usage_type: "licensed",
    },
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: 350,
    unit_amount_decimal: "350",
  };
}

function input(
  overrides: Partial<MembershipPriceInput> = {},
): MembershipPriceInput {
  return {
    expectedUserId: owner,
    eligibility: { user_id: owner, eligible: true },
    standardPriceId: "price_standard",
    earlyAccessPriceId: "price_early350",
    expectedProductId: "prod_membership",
    expectedLivemode: false,
    retrievedEarlyAccessPrice: price(),
    ...overrides,
  };
}

function rejects(
  value: MembershipPriceInput,
  code: EarlyAccessPriceErrorCode,
) {
  let caught: unknown;
  try {
    selectMembershipPrice(value);
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof EarlyAccessPriceError);
  assertEquals(caught.code, code);
  assertEquals(caught.message, "Membership pricing is unavailable.");
  assert(!caught.message.includes(owner));
  assert(!caught.message.includes("price_"));
}

Deno.test("early-access beta price is immutable USD 350 cents per month", () => {
  assertEquals(EARLY_ACCESS_BETA_PRICE, {
    currency: "usd",
    unitAmount: 350,
    interval: "month",
    intervalCount: 1,
    quantity: 1,
  });
  assert(Object.isFrozen(EARLY_ACCESS_BETA_PRICE));
  const selected = selectMembershipPrice(input());
  assertEquals(selected, { kind: "early_access", priceId: "price_early350" });
  assert(Object.isFrozen(selected));
});

Deno.test("ineligible owner keeps the standard path without early-access setup", () => {
  assertEquals(
    selectMembershipPrice(input({
      eligibility: { user_id: owner, eligible: false },
      earlyAccessPriceId: undefined,
      expectedProductId: undefined,
      retrievedEarlyAccessPrice: undefined,
    })),
    { kind: "standard", priceId: "price_standard" },
  );
});

Deno.test("eligible owner does not need or fall back to the standard price", () => {
  assertEquals(
    selectMembershipPrice(input({ standardPriceId: undefined })),
    { kind: "early_access", priceId: "price_early350" },
  );
  rejects(
    input({ retrievedEarlyAccessPrice: { ...price(), unit_amount: 351 } }),
    "early_access_price_invalid",
  );
});

Deno.test("configured standard and early-access prices cannot share an ID", () => {
  for (const eligible of [true, false]) {
    rejects(
      input({
        eligibility: { user_id: owner, eligible },
        standardPriceId: "price_early350",
      }),
      "price_configuration_collision",
    );
  }
});

for (
  const [name, eligibility] of Object.entries({
    missing: undefined,
    null: null,
    boolean: true,
    array: [{ user_id: owner, eligible: true }],
    noOwner: { eligible: true },
    noDecision: { user_id: owner },
    stringDecision: { user_id: owner, eligible: "false" },
    nullDecision: { user_id: owner, eligible: null },
    invalidOwner: { user_id: "not-a-uuid", eligible: true },
    clientAmount: { user_id: owner, eligible: true, amount: 350 },
    metadata: { user_id: owner, eligible: true, user_metadata: {} },
    wrappedRpcError: { data: null, error: { message: "lookup failed" } },
  })
) {
  Deno.test(`canonical eligibility rejects ${name}`, () => {
    rejects(input({ eligibility }), "eligibility_unavailable");
  });
}

Deno.test("canonical owner mismatch rejects both eligible and standard selection", () => {
  for (const eligible of [true, false]) {
    rejects(
      input({ eligibility: { user_id: otherOwner, eligible } }),
      "eligibility_owner_mismatch",
    );
  }
  rejects(input({ expectedUserId: "" }), "eligibility_unavailable");
});

Deno.test("missing normal price rejects only the standard selection", () => {
  for (const standardPriceId of [undefined, ""]) {
    rejects(
      input({
        standardPriceId,
        eligibility: { user_id: owner, eligible: false },
      }),
      "standard_price_unavailable",
    );
  }
});

for (
  const [name, overrides] of Object.entries({
    noPriceId: { earlyAccessPriceId: undefined },
    blankPriceId: { earlyAccessPriceId: "" },
    injectedPriceId: { earlyAccessPriceId: "price_early350?expand[]=product" },
    noProduct: { expectedProductId: undefined },
    invalidProduct: { expectedProductId: "price_early350" },
    noPrice: { retrievedEarlyAccessPrice: undefined },
    nullPrice: { retrievedEarlyAccessPrice: null },
  })
) {
  Deno.test(`eligible price fails closed for unavailable ${name}`, () => {
    rejects(input(overrides), "early_access_price_unavailable");
  });
}

for (
  const [name, patch] of Object.entries({
    wrongId: { id: "price_other" },
    wrongObject: { object: "plan" },
    deactivated: { active: false },
    missingActive: { active: undefined },
    deleted: { deleted: true },
    wrongProduct: { product: "prod_other" },
    expandedProduct: { product: { id: "prod_membership" } },
    wrongMode: { livemode: true },
    missingMode: { livemode: undefined },
    wrongCurrency: { currency: "cad" },
    oneTime: { type: "one_time" },
    tiered: { billing_scheme: "tiered" },
    tiers: { tiers: [] },
    tierMode: { tiers_mode: "volume" },
    transformed: { transform_quantity: { divide_by: 2, round: "up" } },
    customAmount: { custom_unit_amount: { minimum: 350 } },
    missingCustomAmount: { custom_unit_amount: undefined },
    wrongAmount: { unit_amount: 3500 },
    missingAmount: { unit_amount: undefined },
    fractionalAmount: { unit_amount: 350.1 },
    stringAmount: { unit_amount: "350" },
    decimalDisagreement: { unit_amount_decimal: "350.01" },
    decimalCoercion: { unit_amount_decimal: "3.5e2" },
    decimalTooPrecise: { unit_amount_decimal: "350.0000000000000" },
    missingDecimal: { unit_amount_decimal: undefined },
    emptyCurrencyOptions: { currency_options: {} },
    alternateCurrency: { currency_options: { cad: { unit_amount: 350 } } },
    malformedCurrencyOptions: { currency_options: [] },
  })
) {
  Deno.test(`eligible price rejects ${name}`, () => {
    rejects(
      input({ retrievedEarlyAccessPrice: { ...price(), ...patch } }),
      "early_access_price_invalid",
    );
  });
}

for (
  const [name, patch] of Object.entries({
    annual: { interval: "year" },
    multipleMonths: { interval_count: 2 },
    stringCount: { interval_count: "1" },
    metered: { usage_type: "metered" },
    meter: { meter: "mtr_example" },
    defaultTrial: { trial_period_days: 7 },
    missingTrial: { trial_period_days: undefined },
  })
) {
  Deno.test(`eligible price rejects recurring ${name}`, () => {
    const candidate = price();
    candidate.recurring = {
      ...(candidate.recurring as Record<string, unknown>),
      ...patch,
    };
    rejects(
      input({ retrievedEarlyAccessPrice: candidate }),
      "early_access_price_invalid",
    );
  });
}

Deno.test("missing expanded options or recurring object cannot pass validation", () => {
  const candidate = price();
  delete candidate.currency_options;
  rejects(
    input({ retrievedEarlyAccessPrice: candidate }),
    "early_access_price_invalid",
  );
  for (const recurring of [undefined, null, [], "monthly"]) {
    rejects(
      input({ retrievedEarlyAccessPrice: { ...price(), recurring } }),
      "early_access_price_invalid",
    );
  }
  for (const candidate of [[], "price_early350", 350, false]) {
    rejects(
      input({ retrievedEarlyAccessPrice: candidate }),
      "early_access_price_invalid",
    );
  }
});

Deno.test("expanded USD-only fixed option is verified and non-mutating", () => {
  const candidate = price();
  candidate.currency_options = {
    usd: {
      unit_amount: 350,
      unit_amount_decimal: "350.000000000000",
      custom_unit_amount: null,
    },
  };
  candidate.unit_amount_decimal = "350.0";
  const before = JSON.stringify(candidate);
  assertEquals(
    selectMembershipPrice(input({ retrievedEarlyAccessPrice: candidate })),
    { kind: "early_access", priceId: "price_early350" },
  );
  assertEquals(JSON.stringify(candidate), before);
  for (
    const patch of [
      { unit_amount: 349 },
      { unit_amount_decimal: "350.1" },
      { custom_unit_amount: {} },
      { tiers: [] },
    ]
  ) {
    const usd = (candidate.currency_options as Record<string, unknown>).usd;
    rejects(
      input({
        retrievedEarlyAccessPrice: {
          ...candidate,
          currency_options: { usd: { ...usd as object, ...patch } },
        },
      }),
      "early_access_price_invalid",
    );
  }
});

Deno.test("live price requires an explicit matching live-mode expectation", () => {
  assertEquals(
    selectMembershipPrice(input({
      expectedLivemode: true,
      retrievedEarlyAccessPrice: { ...price(), livemode: true },
    })),
    { kind: "early_access", priceId: "price_early350" },
  );
  rejects(
    input({ expectedLivemode: undefined as unknown as boolean }),
    "early_access_price_invalid",
  );
});
