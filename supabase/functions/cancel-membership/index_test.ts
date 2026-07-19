import { HttpError } from "../_shared/http.ts";
import {
  assert,
  assertEquals,
  quietLogger,
  request,
  responseJson,
} from "../_shared/test_helpers.ts";
import { createHandler } from "./index.ts";

type SubscriptionRow = {
  id: string;
  stripe_subscription_id: string;
  status: string;
};

function cancellationAdmin(subscription: SubscriptionRow | null) {
  const state = {
    subscriptionUpdate: null as Record<string, unknown> | null,
    entitlement: null as Record<string, unknown> | null,
  };

  const query: Record<string, any> = {};
  for (const method of ["eq", "neq", "order", "limit"]) {
    query[method] = () => query;
  }
  query.maybeSingle = async () => ({ data: subscription, error: null });

  const admin = {
    from: (table: string) => {
      if (table === "subscriptions") {
        return {
          select: () => query,
          update: (values: Record<string, unknown>) => {
            state.subscriptionUpdate = values;
            let filters = 0;
            const updateQuery: Record<string, any> = {
              eq: () => {
                filters += 1;
                return filters === 2
                  ? Promise.resolve({ error: null })
                  : updateQuery;
              },
            };
            return updateQuery;
          },
        };
      }
      if (table === "entitlements") {
        return {
          upsert: async (values: Record<string, unknown>) => {
            state.entitlement = values;
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return { admin, state };
}

function cancelHandler(
  subscription: SubscriptionRow | null,
  overrides: Record<string, unknown> = {},
) {
  const fixture = cancellationAdmin(subscription);
  return {
    ...fixture,
    handler: createHandler({
      requireUser: async () => ({ id: "user-1" }),
      createAdminClient: () => fixture.admin,
      stripeRequest: async () => ({
        id: "sub_1",
        status: "canceled",
        cancel_at_period_end: false,
        canceled_at: null,
        current_period_start: 1_799_900_000,
        current_period_end: 1_800_100_000,
      }),
      now: () => new Date("2027-01-15T08:00:00.000Z"),
      logger: quietLogger,
      ...overrides,
    } as any),
  };
}

Deno.test("cancellation handles preflight and rejects unsupported methods", async () => {
  assertEquals(
    (await cancelHandler(null).handler(request("OPTIONS"))).status,
    200,
  );
  assertEquals((await cancelHandler(null).handler(request("GET"))).status, 405);
});

Deno.test("cancellation returns 401 when authentication fails", async () => {
  const { handler } = cancelHandler(null, {
    requireUser: async () => {
      throw new HttpError("Not authenticated.", 401);
    },
  });
  assertEquals((await handler(request("POST"))).status, 401);
});

Deno.test("cancellation revokes local access when no Stripe subscription exists", async () => {
  const { handler, state } = cancelHandler(null);
  const response = await handler(request("POST"));

  assertEquals(response.status, 200);
  assertEquals(await responseJson(response), {
    canceled: false,
    accessRemoved: true,
  });
  assertEquals(state.entitlement?.status, "revoked");
  assertEquals(state.entitlement?.ends_at, "2027-01-15T08:00:00.000Z");
});

Deno.test("cancellation deletes the Stripe subscription and revokes access", async () => {
  let stripePath = "";
  let stripeMethod = "";
  const { handler, state } = cancelHandler({
    id: "local-sub",
    stripe_subscription_id: "sub/1",
    status: "active",
  }, {
    stripeRequest: async (path: string, method: string) => {
      stripePath = path;
      stripeMethod = method;
      return {
        id: "sub_1",
        status: "canceled",
        cancel_at_period_end: false,
        canceled_at: 1_800_000_000,
        current_period_start: 1_799_900_000,
        current_period_end: 1_800_100_000,
      };
    },
  });
  const response = await handler(request("POST"));

  assertEquals(response.status, 200);
  assertEquals(stripePath, "/v1/subscriptions/sub%2F1");
  assertEquals(stripeMethod, "DELETE");
  assertEquals(state.subscriptionUpdate?.status, "canceled");
  assertEquals(state.entitlement?.source_id, "sub_1");
});

Deno.test("cancellation returns 500 and retains local state when Stripe fails", async () => {
  const { handler, state } = cancelHandler({
    id: "local-sub",
    stripe_subscription_id: "sub_1",
    status: "active",
  }, {
    stripeRequest: async () => {
      throw new Error("Stripe unavailable");
    },
  });
  const response = await handler(request("POST"));

  assertEquals(response.status, 500);
  assertEquals(
    (await responseJson(response)).error,
    "Unable to cancel membership.",
  );
  assertEquals(state.subscriptionUpdate, null);
  assertEquals(state.entitlement, null);
  assert(!response.ok);
});
