import { type EnvReader, readEnv, resolveSiteOrigin } from "./http.ts";

const encoder = new TextEncoder();

type StripeMethod = "DELETE" | "GET" | "POST";

type StripeRequestOptions = {
  env?: EnvReader;
  fetch?: typeof fetch;
};

type SignatureOptions = {
  env?: EnvReader;
  now?: () => number;
  toleranceSeconds?: number;
};

function getEnv(name: string, env: EnvReader = readEnv) {
  const value = env(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

export function getSiteUrl(req: Request, env: EnvReader = readEnv) {
  return resolveSiteOrigin(req, env);
}

export function getPriceId(productKey: string, env: EnvReader = readEnv) {
  if (productKey === "dominion_membership") {
    return getEnv("STRIPE_MEMBERSHIP_PRICE_ID", env);
  }
  throw new Error(`Unsupported product key: ${productKey}`);
}

export function createFormBody(
  values: Record<string, string | number | boolean | undefined>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params;
}

export async function stripeRequest(
  path: string,
  method: StripeMethod,
  body?: URLSearchParams,
  options: StripeRequestOptions = {},
) {
  const secretKey = getEnv("STRIPE_SECRET_KEY", options.env);
  const request = options.fetch || fetch;
  const response = await request(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });

  const payload = await response.text();
  let data = null;
  try {
    data = payload ? JSON.parse(payload) : null;
  } catch {
    throw new Error(
      response.ok
        ? "Stripe returned an invalid response."
        : "Stripe request failed.",
    );
  }
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

export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  options: SignatureOptions = {},
) {
  const webhookSecret = getEnv("STRIPE_WEBHOOK_SECRET", options.env);
  if (!header) return false;

  const timestamp = header
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("t="))
    ?.slice(2);
  const signatures = header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));

  const timestampSeconds = Number(timestamp);
  if (!timestamp || !Number.isFinite(timestampSeconds) || !signatures.length) {
    return false;
  }

  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const nowSeconds = Math.floor((options.now || Date.now)() / 1000);
  if (
    toleranceSeconds >= 0 &&
    Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds
  ) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`),
  );
  const expected = hex(digest);

  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

export function toIsoDateTime(value?: number | null) {
  if (!value) return null;
  return new Date(value * 1000).toISOString();
}
