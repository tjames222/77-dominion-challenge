import { HttpError } from "../_shared/http.ts";
import {
  assert,
  assertEquals,
  quietLogger,
  request,
  responseJson,
} from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";

function entitlementAdmin(
  data: Array<{ entitlement_key: string; status: string }> = [],
  error: Error | null = null,
) {
  return {
    from: () => ({
      select: () => ({
        eq: async () => ({ data, error }),
      }),
    }),
  };
}

function checkoutHandler(overrides: Record<string, unknown> = {}) {
  return createHandler({
    requireUser: async () => ({ id: "user-1", email: "member@example.com" }),
    createAdminClient: () => entitlementAdmin(),
    getOrCreateStripeCustomer: async () => "cus_1",
    getSiteUrl: () => "https://app.example.com",
    getPriceId: () => "price_1",
    stripeRequest: async () => ({
      url: "https://checkout.stripe.test/session",
    }),
    logger: quietLogger,
    ...overrides,
  } as any);
}

Deno.test("checkout handles preflight and rejects unsupported methods", async () => {
  assertEquals((await checkoutHandler()(request("OPTIONS"))).status, 200);
  assertEquals((await checkoutHandler()(request("GET"))).status, 405);
});

Deno.test("checkout returns 401 when authentication fails", async () => {
  const response = await checkoutHandler({
    requireUser: async () => {
      throw new HttpError("Not authenticated.", 401);
    },
  })(request("POST", { productKey: "dominion_membership" }));

  assertEquals(response.status, 401);
  assertEquals((await responseJson(response)).error, "Not authenticated.");
});

Deno.test("checkout validates JSON and product selection", async () => {
  const invalidJson = await checkoutHandler()(request("POST", "{"));
  assertEquals(invalidJson.status, 400);

  const unsupported = await checkoutHandler()(
    request("POST", { productKey: "unknown" }),
  );
  assertEquals(unsupported.status, 400);
  assertEquals(
    (await responseJson(unsupported)).error,
    "Unsupported product selection.",
  );
});

Deno.test("checkout returns an existing member to the dashboard", async () => {
  let requestedStripe = false;
  const response = await checkoutHandler({
    createAdminClient: () =>
      entitlementAdmin([{
        entitlement_key: "membership_active",
        status: "active",
      }]),
    stripeRequest: async () => {
      requestedStripe = true;
      return {};
    },
  })(request("POST", { productKey: "dominion_membership" }));

  assertEquals(response.status, 200);
  assertEquals(await responseJson(response), {
    url: "https://app.example.com/dashboard.html",
    alreadyOwned: true,
  });
  assertEquals(requestedStripe, false);
});

Deno.test("checkout creates a Stripe subscription session", async () => {
  let stripeBody: URLSearchParams | undefined;
  const response = await checkoutHandler({
    stripeRequest: async (
      _path: string,
      _method: string,
      body: URLSearchParams,
    ) => {
      stripeBody = body;
      return { url: "https://checkout.stripe.test/session" };
    },
  })(request("POST", { productKey: "dominion_membership" }));

  assertEquals(response.status, 200);
  assertEquals(
    (await responseJson(response)).url,
    "https://checkout.stripe.test/session",
  );
  assert(stripeBody);
  assertEquals(stripeBody.get("customer"), "cus_1");
  assertEquals(stripeBody.get("line_items[0][price]"), "price_1");
  assertEquals(stripeBody.get("client_reference_id"), "user-1");
});

Deno.test("checkout returns 500 when Stripe fails", async () => {
  const response = await checkoutHandler({
    stripeRequest: async () => {
      throw new Error("Stripe unavailable");
    },
  })(request("POST", { productKey: "dominion_membership" }));

  assertEquals(response.status, 500);
  assertEquals(
    (await responseJson(response)).error,
    "Unable to create checkout session.",
  );
});
