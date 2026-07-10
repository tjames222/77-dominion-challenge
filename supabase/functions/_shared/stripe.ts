import { resolveSiteOrigin } from "./http.ts";

const encoder = new TextEncoder();

type StripeMethod = "DELETE" | "GET" | "POST";

function getEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

export function getSiteUrl(req: Request) {
  return resolveSiteOrigin(req);
}

export function getPriceId(productKey: string) {
  if (productKey === "dominion_membership") return getEnv("STRIPE_MEMBERSHIP_PRICE_ID");
  throw new Error(`Unsupported product key: ${productKey}`);
}

export function createFormBody(values: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params;
}

export async function stripeRequest(path: string, method: StripeMethod, body?: URLSearchParams) {
  const secretKey = getEnv("STRIPE_SECRET_KEY");
  const response = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });

  const payload = await response.text();
  const data = payload ? JSON.parse(payload) : null;
  if (!response.ok) {
    throw new Error(data?.error?.message || "Stripe request failed.");
  }

  return data;
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function verifyStripeSignature(payload: string, header: string | null) {
  const webhookSecret = getEnv("STRIPE_WEBHOOK_SECRET");
  if (!header) return false;

  const timestamp = header
    .split(",")
    .find((part) => part.startsWith("t="))
    ?.slice(2);
  const signatures = header
    .split(",")
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));

  if (!timestamp || !signatures.length) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`));
  const expected = hex(digest);

  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

export function toIsoDateTime(value?: number | null) {
  if (!value) return null;
  return new Date(value * 1000).toISOString();
}
