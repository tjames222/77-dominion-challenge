import { createAdminClient } from "../_shared/supabase.ts";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  optionsResponse,
} from "../_shared/http.ts";
import {
  stripeRequest,
  toIsoDateTime,
  verifyStripeSignature,
} from "../_shared/stripe.ts";

type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  current_period_start: number | null;
  current_period_end: number | null;
  metadata?: Record<string, string>;
  items?: {
    data: Array<{
      price?: { id?: string | null };
    }>;
  };
};

function subscriptionStatusToEntitlement(status: string) {
  return status === "active" || status === "trialing"
    ? "active"
    : status === "canceled"
    ? "expired"
    : "inactive";
}

async function findUserIdByCustomer(
  admin: ReturnType<typeof createAdminClient>,
  stripeCustomerId: string | null,
) {
  if (!stripeCustomerId) return null;
  const { data, error } = await admin
    .from("billing_customers")
    .select("user_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id || null;
}

async function upsertSubscriptionEntitlement(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  subscriptionId: string,
  subscriptionStatus: string,
  currentPeriodEnd: number | null,
  now: () => Date,
) {
  const entitlementStatus = subscriptionStatusToEntitlement(subscriptionStatus);
  const { error } = await admin.from("entitlements").upsert({
    user_id: userId,
    entitlement_key: "membership_active",
    status: entitlementStatus,
    source_type: "subscription",
    source_id: subscriptionId,
    starts_at: now().toISOString(),
    ends_at: entitlementStatus === "active"
      ? toIsoDateTime(currentPeriodEnd)
      : now().toISOString(),
    metadata: { productKey: "dominion_membership", subscriptionStatus },
  }, { onConflict: "user_id,entitlement_key" });
  if (error) throw error;
}

type SyncDependencies = {
  stripeRequest: typeof stripeRequest;
  now: () => Date;
};

async function syncSubscriptionFromStripe(
  admin: ReturnType<typeof createAdminClient>,
  subscriptionId: string,
  dependencies: SyncDependencies,
) {
  const subscription = await dependencies.stripeRequest(
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    "GET",
  ) as StripeSubscription;
  const stripeCustomerId = typeof subscription.customer === "string"
    ? subscription.customer
    : null;
  const userId = subscription.metadata?.user_id ||
    await findUserIdByCustomer(admin, stripeCustomerId);
  if (!userId) return;

  const { error } = await admin.from("subscriptions").upsert({
    user_id: userId,
    product_key: subscription.metadata?.product_key || "dominion_membership",
    status: subscription.status,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscription.metadata?.price_id ||
      subscription.items?.data?.[0]?.price?.id || null,
    cancel_at_period_end: subscription.cancel_at_period_end,
    current_period_start: toIsoDateTime(subscription.current_period_start),
    current_period_end: toIsoDateTime(subscription.current_period_end),
    canceled_at: toIsoDateTime(subscription.canceled_at),
  }, { onConflict: "stripe_subscription_id" });
  if (error) throw error;

  await upsertSubscriptionEntitlement(
    admin,
    userId,
    subscription.id,
    subscription.status,
    subscription.current_period_end,
    dependencies.now,
  );
}

type Dependencies = {
  createAdminClient: typeof createAdminClient;
  stripeRequest: typeof stripeRequest;
  verifyStripeSignature: typeof verifyStripeSignature;
  now: () => Date;
  logger: Pick<Console, "error">;
};

const defaultDependencies: Dependencies = {
  createAdminClient,
  stripeRequest,
  verifyStripeSignature,
  now: () => new Date(),
  logger: console,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async (req: Request) => {
    if (req.method === "OPTIONS") return optionsResponse(req);
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405, req);
    }

    const payload = await req.text();

    try {
      const isValid = await dependencies.verifyStripeSignature(
        payload,
        req.headers.get("stripe-signature"),
      );
      if (!isValid) throw new HttpError("Invalid Stripe signature.", 400);

      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        throw new HttpError("Webhook payload must be valid JSON.", 400);
      }
      if (!isRecord(event) || typeof event.type !== "string") {
        throw new HttpError("Webhook event is missing its type.", 400);
      }

      const object = isRecord(event.data) && isRecord(event.data.object)
        ? event.data.object
        : null;

      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
          if (!object) {
            throw new HttpError(
              "Webhook event is missing its data object.",
              400,
            );
          }
          if (
            object.mode === "subscription" &&
            typeof object.subscription === "string"
          ) {
            const admin = dependencies.createAdminClient();
            await syncSubscriptionFromStripe(
              admin,
              object.subscription,
              dependencies,
            );
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          if (!object || typeof object.id !== "string") {
            throw new HttpError("Webhook subscription is missing its id.", 400);
          }
          const admin = dependencies.createAdminClient();
          await syncSubscriptionFromStripe(admin, object.id, dependencies);
          break;
        }
        default:
          break;
      }

      return jsonResponse({ received: true }, 200, req);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) {
        dependencies.logger.error(error);
      }
      return errorResponse(error, "Webhook processing failed.", req);
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
