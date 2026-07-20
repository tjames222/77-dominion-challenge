import {
  assertEquals,
  quietLogger,
  request,
  responseJson,
} from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";

function webhookAdmin(
  errors: { subscription?: Error; entitlement?: Error } = {},
) {
  const state = {
    subscriptions: [] as Array<
      { values: Record<string, unknown>; options: Record<string, unknown> }
    >,
    entitlements: [] as Array<
      { values: Record<string, unknown>; options: Record<string, unknown> }
    >,
    subscriptionRows: new Map<string, Record<string, unknown>>(),
    entitlementRows: new Map<string, Record<string, unknown>>(),
  };
  const admin = {
    from: (table: string) => {
      if (table === "subscriptions") {
        return {
          upsert: async (
            values: Record<string, unknown>,
            options: Record<string, unknown>,
          ) => {
            state.subscriptions.push({ values, options });
            state.subscriptionRows.set(
              String(values.stripe_subscription_id),
              values,
            );
            return { error: errors.subscription || null };
          },
        };
      }
      if (table === "entitlements") {
        return {
          upsert: async (
            values: Record<string, unknown>,
            options: Record<string, unknown>,
          ) => {
            state.entitlements.push({ values, options });
            state.entitlementRows.set(
              `${values.user_id}:${values.entitlement_key}`,
              values,
            );
            return { error: errors.entitlement || null };
          },
        };
      }
      if (table === "billing_customers") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { user_id: "user-from-customer" },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
  return { admin, state };
}

function stripeSubscription() {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    canceled_at: null,
    current_period_start: 1_799_900_000,
    current_period_end: 1_800_100_000,
    metadata: {
      user_id: "user-1",
      product_key: "dominion_membership",
      price_id: "price_1",
    },
  };
}

function subscriptionEvent() {
  return {
    id: "evt_1",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_1" } },
  };
}

function webhookHandler(
  overrides: Record<string, unknown> = {},
  errors: { subscription?: Error; entitlement?: Error } = {},
) {
  const fixture = webhookAdmin(errors);
  return {
    ...fixture,
    handler: createHandler({
      verifyStripeSignature: async () => true,
      createAdminClient: () => fixture.admin,
      stripeRequest: async () => stripeSubscription(),
      now: () => new Date("2027-01-15T08:00:00.000Z"),
      logger: quietLogger,
      ...overrides,
    } as any),
  };
}

function webhookRequest(body: unknown, signature = "t=1800000000,v1=test") {
  return request("POST", body, { "stripe-signature": signature });
}

Deno.test("webhook handles preflight and rejects unsupported methods", async () => {
  assertEquals(
    (await webhookHandler().handler(request("OPTIONS"))).status,
    200,
  );
  assertEquals((await webhookHandler().handler(request("GET"))).status, 405);
});

Deno.test("webhook rejects invalid signatures before creating an admin client", async () => {
  let adminCreated = false;
  const { handler } = webhookHandler({
    verifyStripeSignature: async () => false,
    createAdminClient: () => {
      adminCreated = true;
      return {};
    },
  });
  const response = await handler(
    webhookRequest(subscriptionEvent(), "invalid"),
  );

  assertEquals(response.status, 400);
  assertEquals(
    (await responseJson(response)).error,
    "Invalid Stripe signature.",
  );
  assertEquals(adminCreated, false);
});

Deno.test("webhook returns 500 when signature verification is misconfigured", async () => {
  const { handler } = webhookHandler({
    verifyStripeSignature: async () => {
      throw new Error("Missing STRIPE_WEBHOOK_SECRET.");
    },
  });
  const response = await handler(webhookRequest(subscriptionEvent()));

  assertEquals(response.status, 500);
});

Deno.test("webhook validates signed JSON and event structure", async () => {
  assertEquals(
    (await webhookHandler().handler(webhookRequest("{"))).status,
    400,
  );
  assertEquals(
    (await webhookHandler().handler(webhookRequest({ data: {} }))).status,
    400,
  );
});

Deno.test("webhook acknowledges unhandled event types without provider calls", async () => {
  let providerCalls = 0;
  const { handler } = webhookHandler({
    stripeRequest: async () => {
      providerCalls += 1;
      return stripeSubscription();
    },
  });
  const response = await handler(
    webhookRequest({ type: "invoice.created", data: { object: {} } }),
  );

  assertEquals(response.status, 200);
  assertEquals(await responseJson(response), { received: true });
  assertEquals(providerCalls, 0);
});

Deno.test("webhook sync is idempotent when Stripe retries an event", async () => {
  let providerCalls = 0;
  const fixture = webhookHandler({
    stripeRequest: async () => {
      providerCalls += 1;
      return stripeSubscription();
    },
  });

  const first = await fixture.handler(webhookRequest(subscriptionEvent()));
  const retry = await fixture.handler(webhookRequest(subscriptionEvent()));

  assertEquals(first.status, 200);
  assertEquals(retry.status, 200);
  assertEquals(providerCalls, 2);
  assertEquals(fixture.state.subscriptions.length, 2);
  assertEquals(fixture.state.subscriptionRows.size, 1);
  assertEquals(fixture.state.entitlementRows.size, 1);
  assertEquals(
    fixture.state.subscriptionRows.get("sub_1")?.status,
    "active",
  );
  assertEquals(
    fixture.state.entitlementRows.get("user-1:membership_active")?.status,
    "active",
  );
  assertEquals(
    fixture.state.subscriptions[0].options.onConflict,
    "stripe_subscription_id",
  );
  assertEquals(
    fixture.state.entitlements[0].options.onConflict,
    "user_id,entitlement_key",
  );
});

Deno.test("webhook returns 500 for provider failure so Stripe can retry", async () => {
  let attempts = 0;
  const fixture = webhookHandler({
    stripeRequest: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Stripe unavailable");
      return stripeSubscription();
    },
  });

  const failed = await fixture.handler(webhookRequest(subscriptionEvent()));
  const retried = await fixture.handler(webhookRequest(subscriptionEvent()));

  assertEquals(failed.status, 500);
  assertEquals(retried.status, 200);
  assertEquals(attempts, 2);
  assertEquals(fixture.state.subscriptions.length, 1);
});

Deno.test("webhook returns 500 when persistence fails so Stripe can retry", async () => {
  const fixture = webhookHandler({}, {
    entitlement: new Error("database unavailable"),
  });
  const response = await fixture.handler(webhookRequest(subscriptionEvent()));

  assertEquals(response.status, 500);
  assertEquals(
    (await responseJson(response)).error,
    "Webhook processing failed.",
  );
  assertEquals(fixture.state.subscriptions.length, 1);
  assertEquals(fixture.state.entitlements.length, 1);
});

Deno.test("checkout completion syncs its subscription id", async () => {
  let requestedPath = "";
  const fixture = webhookHandler({
    stripeRequest: async (path: string) => {
      requestedPath = path;
      return stripeSubscription();
    },
  });
  const response = await fixture.handler(webhookRequest({
    type: "checkout.session.completed",
    data: { object: { mode: "subscription", subscription: "sub/1" } },
  }));

  assertEquals(response.status, 200);
  assertEquals(requestedPath, "/v1/subscriptions/sub%2F1");
});
