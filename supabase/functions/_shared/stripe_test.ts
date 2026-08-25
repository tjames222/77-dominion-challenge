import { assert, assertEquals } from "./test_helpers.ts";
import {
  createFormBody,
  getPriceId,
  stripeRequest,
  verifyStripeSignature,
} from "./stripe.ts";

const encoder = new TextEncoder();

async function signature(secret: string, timestamp: number, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("Stripe form bodies omit undefined values and preserve false", () => {
  const body = createFormBody({
    name: "Dominion",
    count: 1,
    enabled: false,
    omitted: undefined,
  });
  assertEquals(body.toString(), "name=Dominion&count=1&enabled=false");
});

Deno.test("Stripe configuration is read lazily from an injected environment", () => {
  assertEquals(
    getPriceId(
      "dominion_membership",
      (name) =>
        name === "STRIPE_MEMBERSHIP_PRICE_ID" ? "price_test" : undefined,
    ),
    "price_test",
  );
});

Deno.test("stripeRequest isolates and validates the network boundary", async () => {
  let authorization = "";
  const result = await stripeRequest(
    "/v1/test",
    "POST",
    new URLSearchParams({ value: "1" }),
    {
      env: () => "sk_test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("authorization") || "";
        return new Response(JSON.stringify({ id: "result-1" }), {
          status: 200,
        });
      }) as typeof fetch,
    },
  );

  assertEquals(authorization, "Bearer sk_test");
  assertEquals(result, { id: "result-1" });
});

Deno.test("stripeRequest surfaces provider errors", async () => {
  try {
    await stripeRequest("/v1/test", "GET", undefined, {
      env: () => "sk_test",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: "card declined" } }), {
          status: 402,
        })) as typeof fetch,
    });
    throw new Error("Expected stripeRequest to reject");
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.message, "card declined");
  }
});

Deno.test("Stripe webhook signature accepts a current valid v1 signature", async () => {
  const secret = "whsec_test";
  const now = 1_800_000_000_000;
  const timestamp = Math.floor(now / 1000);
  const payload = JSON.stringify({ id: "evt_1" });
  const digest = await signature(secret, timestamp, payload);

  const valid = await verifyStripeSignature(
    payload,
    `t=${timestamp},v1=invalid,v1=${digest}`,
    {
      env: () => secret,
      now: () => now,
    },
  );

  assert(valid);
});

Deno.test("Stripe webhook signature rejects stale and altered payloads", async () => {
  const secret = "whsec_test";
  const now = 1_800_000_000_000;
  const timestamp = Math.floor(now / 1000) - 301;
  const payload = JSON.stringify({ id: "evt_1" });
  const digest = await signature(secret, timestamp, payload);

  assertEquals(
    await verifyStripeSignature(payload, `t=${timestamp},v1=${digest}`, {
      env: () => secret,
      now: () => now,
    }),
    false,
  );
  assertEquals(
    await verifyStripeSignature(
      `${payload}x`,
      `t=${Math.floor(now / 1000)},v1=${digest}`,
      {
        env: () => secret,
        now: () => now,
      },
    ),
    false,
  );
});
