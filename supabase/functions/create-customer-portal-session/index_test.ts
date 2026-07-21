import { HttpError } from "../_shared/http.ts";
import {
  assert,
  assertEquals,
  quietLogger,
  request,
  responseJson,
} from "../_shared/test_helpers.ts";
import { createHandler, resolveReturnUrl } from "./index.ts";

function portalHandler(overrides: Record<string, unknown> = {}) {
  return createHandler({
    requireUser: async () => ({ id: "user-1", email: "member@example.com" }),
    createAdminClient: () => ({}),
    getOrCreateStripeCustomer: async () => "cus_1",
    getSiteUrl: () => "https://app.example.com",
    stripeRequest: async () => ({ url: "https://billing.stripe.test/session" }),
    logger: quietLogger,
    ...overrides,
  } as any);
}

Deno.test("portal handles preflight and rejects unsupported methods", async () => {
  assertEquals((await portalHandler()(request("OPTIONS"))).status, 200);
  assertEquals((await portalHandler()(request("GET"))).status, 405);
});

Deno.test("portal returns 401 when authentication fails", async () => {
  const response = await portalHandler({
    requireUser: async () => {
      throw new HttpError("Not authenticated.", 401);
    },
  })(request("POST", {}));

  assertEquals(response.status, 401);
});

Deno.test("portal validates JSON, flow, and returnPath", async () => {
  assertEquals((await portalHandler()(request("POST", "{"))).status, 400);
  assertEquals(
    (await portalHandler()(request("POST", { flow: "subscription_cancel" })))
      .status,
    400,
  );
  assertEquals(
    (await portalHandler()(request("POST", { returnPath: 42 }))).status,
    400,
  );
});

Deno.test("portal constrains return URLs to the configured site", () => {
  assertEquals(
    resolveReturnUrl(
      "https://app.example.com",
      "/billing.html?from=profile",
      "/profile.html#billing",
    ),
    "https://app.example.com/billing.html?from=profile",
  );
  assertEquals(
    resolveReturnUrl(
      "https://app.example.com",
      "https://attacker.example/steal",
      "/profile.html#billing",
    ),
    "https://app.example.com/profile.html#billing",
  );
});

Deno.test("portal creates a payment-method update session", async () => {
  let stripeBody: URLSearchParams | undefined;
  const response = await portalHandler({
    stripeRequest: async (
      _path: string,
      _method: string,
      body: URLSearchParams,
    ) => {
      stripeBody = body;
      return { url: "https://billing.stripe.test/session" };
    },
  })(
    request("POST", {
      flow: "payment_method_update",
      returnPath: "/billing.html",
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(
    (await responseJson(response)).url,
    "https://billing.stripe.test/session",
  );
  assert(stripeBody);
  assertEquals(stripeBody.get("customer"), "cus_1");
  assertEquals(
    stripeBody.get("return_url"),
    "https://app.example.com/billing.html",
  );
  assertEquals(stripeBody.get("flow_data[type]"), "payment_method_update");
});

Deno.test("portal returns 500 when Stripe fails", async () => {
  const response = await portalHandler({
    stripeRequest: async () => {
      throw new Error("Stripe unavailable");
    },
  })(request("POST", {}));

  assertEquals(response.status, 500);
  assertEquals(
    (await responseJson(response)).error,
    "Unable to open billing portal.",
  );
});
