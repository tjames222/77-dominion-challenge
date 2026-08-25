import { assert, assertEquals } from "./test_helpers.ts";
import { getOrCreateStripeCustomer } from "./billing.ts";

type FixtureOptions = {
  customer?: { stripe_customer_id: string } | null;
  profile?: { name?: string | null; email?: string | null } | null;
  customerError?: Error | null;
  profileError?: Error | null;
  upsertError?: Error | null;
};

function billingAdmin(options: FixtureOptions = {}) {
  const state = {
    upserts: [] as Array<{
      values: Record<string, unknown>;
      options: Record<string, unknown>;
    }>,
  };

  const resultFor = (table: string) => {
    if (table === "billing_customers") {
      return {
        data: options.customer ?? null,
        error: options.customerError ?? null,
      };
    }
    if (table === "profiles") {
      return {
        data: options.profile ?? null,
        error: options.profileError ?? null,
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };

  return {
    state,
    admin: {
      from: (table: string) => ({
        select: () => {
          const query = {
            eq: () => query,
            maybeSingle: async () => resultFor(table),
          };
          return query;
        },
        upsert: async (
          values: Record<string, unknown>,
          upsertOptions: Record<string, unknown>,
        ) => {
          state.upserts.push({ values, options: upsertOptions });
          return { error: options.upsertError ?? null };
        },
      }),
    },
  };
}

async function assertRejectsWith(
  operation: () => Promise<unknown>,
  expectedMessage: string,
) {
  try {
    await operation();
    throw new Error("Expected operation to reject");
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.message, expectedMessage);
  }
}

Deno.test("billing customer lookup reuses the existing Stripe customer", async () => {
  const fixture = billingAdmin({
    customer: { stripe_customer_id: "cus_existing" },
    profile: { name: "Existing Member", email: "existing@example.com" },
  });
  let providerCalled = false;

  const customerId = await getOrCreateStripeCustomer(
    fixture.admin,
    { id: "user-1", email: "existing@example.com" },
    async () => {
      providerCalled = true;
      return { id: "cus_unexpected" };
    },
  );

  assertEquals(customerId, "cus_existing");
  assertEquals(providerCalled, false);
  assertEquals(fixture.state.upserts.length, 0);
});

Deno.test("billing customer creation sends normalized profile data and persists the mapping", async () => {
  const fixture = billingAdmin({
    profile: { name: "Profile Name", email: "profile@example.com" },
  });
  let providerBody: URLSearchParams | undefined;

  const customerId = await getOrCreateStripeCustomer(
    fixture.admin,
    {
      id: "user-2",
      email: null,
      user_metadata: { name: "Metadata Name" },
    },
    async (_path, _method, body) => {
      providerBody = body;
      return { id: "cus_created" };
    },
  );

  assertEquals(customerId, "cus_created");
  assert(providerBody);
  assertEquals(providerBody.get("email"), "profile@example.com");
  assertEquals(providerBody.get("name"), "Profile Name");
  assertEquals(providerBody.get("metadata[user_id]"), "user-2");
  assertEquals(fixture.state.upserts.length, 1);
  assertEquals(
    fixture.state.upserts[0].values.stripe_customer_id,
    "cus_created",
  );
  assertEquals(fixture.state.upserts[0].options.onConflict, "user_id");
});

Deno.test("billing customer lookup and persistence failures stop the flow", async () => {
  const lookupFixture = billingAdmin({
    customerError: new Error("customer lookup failed"),
  });
  await assertRejectsWith(
    () =>
      getOrCreateStripeCustomer(
        lookupFixture.admin,
        { id: "user-3" },
        async () => ({ id: "cus_unexpected" }),
      ),
    "customer lookup failed",
  );

  const persistenceFixture = billingAdmin({
    upsertError: new Error("mapping write failed"),
  });
  await assertRejectsWith(
    () =>
      getOrCreateStripeCustomer(
        persistenceFixture.admin,
        { id: "user-4", email: "member@example.com" },
        async () => ({ id: "cus_created" }),
      ),
    "mapping write failed",
  );
});
