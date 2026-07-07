import { createAdminClient } from "../_shared/supabase.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { stripeRequest, toIsoDateTime, verifyStripeSignature } from "../_shared/stripe.ts";

type StripeCheckoutSession = {
  id: string;
  mode: "payment" | "subscription";
  customer: string | null;
  client_reference_id: string | null;
  payment_intent: string | null;
  payment_status: string;
  amount_total: number | null;
  currency: string | null;
  status: string;
  created: number;
  subscription?: string | null;
  metadata?: Record<string, string>;
};

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

function membershipStatusToEntitlement(status: string) {
  return status === "active" || status === "trialing" ? "active" : status === "canceled" ? "expired" : "inactive";
}

async function findUserIdByCustomer(admin: ReturnType<typeof createAdminClient>, stripeCustomerId: string | null) {
  if (!stripeCustomerId) return null;
  const { data } = await admin
    .from("billing_customers")
    .select("user_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  return data?.user_id || null;
}

async function upsertChallengeEntitlement(admin: ReturnType<typeof createAdminClient>, userId: string, sourceId: string | null, status: "active" | "revoked") {
  const active = status === "active";
  await admin.from("entitlements").upsert({
    user_id: userId,
    entitlement_key: "challenge_77_access",
    status,
    source_type: "purchase",
    source_id: sourceId,
    starts_at: active ? new Date().toISOString() : null,
    ends_at: active ? null : new Date().toISOString(),
    metadata: { productKey: "challenge_77" },
  }, { onConflict: "user_id,entitlement_key" });
}

async function upsertMembershipEntitlement(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  subscriptionId: string,
  subscriptionStatus: string,
  currentPeriodEnd: number | null,
) {
  const entitlementStatus = membershipStatusToEntitlement(subscriptionStatus);
  await admin.from("entitlements").upsert({
    user_id: userId,
    entitlement_key: "membership_active",
    status: entitlementStatus,
    source_type: "subscription",
    source_id: subscriptionId,
    starts_at: new Date().toISOString(),
    ends_at: entitlementStatus === "active" ? toIsoDateTime(currentPeriodEnd) : new Date().toISOString(),
    metadata: { productKey: "dominion_membership", subscriptionStatus },
  }, { onConflict: "user_id,entitlement_key" });
}

async function syncPurchaseFromSession(admin: ReturnType<typeof createAdminClient>, session: StripeCheckoutSession) {
  if (session.mode !== "payment") return;

  const userId = session.client_reference_id || session.metadata?.user_id || await findUserIdByCustomer(admin, session.customer);
  if (!userId) return;

  await admin.from("purchases").upsert({
    user_id: userId,
    product_key: session.metadata?.product_key || "challenge_77",
    status: session.payment_status === "paid" ? "paid" : session.status === "expired" ? "expired" : "pending",
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: session.payment_intent,
    stripe_customer_id: session.customer,
    stripe_price_id: session.metadata?.price_id || null,
    amount_total: session.amount_total,
    currency: session.currency || "usd",
    purchased_at: session.payment_status === "paid" ? toIsoDateTime(session.created) : null,
  }, { onConflict: "stripe_checkout_session_id" });

  if (session.payment_status === "paid") {
    await upsertChallengeEntitlement(admin, userId, session.id, "active");
  }
}

async function syncSubscriptionFromStripe(admin: ReturnType<typeof createAdminClient>, subscriptionId: string) {
  const subscription = await stripeRequest(`/v1/subscriptions/${subscriptionId}`, "GET") as StripeSubscription;
  const stripeCustomerId = typeof subscription.customer === "string" ? subscription.customer : null;
  const userId = subscription.metadata?.user_id || await findUserIdByCustomer(admin, stripeCustomerId);
  if (!userId) return;

  await admin.from("subscriptions").upsert({
    user_id: userId,
    product_key: subscription.metadata?.product_key || "dominion_membership",
    status: subscription.status,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscription.metadata?.price_id || subscription.items?.data?.[0]?.price?.id || null,
    cancel_at_period_end: subscription.cancel_at_period_end,
    current_period_start: toIsoDateTime(subscription.current_period_start),
    current_period_end: toIsoDateTime(subscription.current_period_end),
    canceled_at: toIsoDateTime(subscription.canceled_at),
  }, { onConflict: "stripe_subscription_id" });

  await upsertMembershipEntitlement(admin, userId, subscription.id, subscription.status, subscription.current_period_end);
}

async function handleRefund(admin: ReturnType<typeof createAdminClient>, charge: Record<string, unknown>) {
  const paymentIntent = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
  if (!paymentIntent) return;

  const { data: purchase } = await admin
    .from("purchases")
    .select("user_id, stripe_checkout_session_id")
    .eq("stripe_payment_intent_id", paymentIntent)
    .maybeSingle();

  if (!purchase?.user_id) return;

  await admin.from("purchases")
    .update({ status: "refunded" })
    .eq("stripe_payment_intent_id", paymentIntent);

  await upsertChallengeEntitlement(admin, purchase.user_id, purchase.stripe_checkout_session_id, "revoked");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const payload = await req.text();
  const isValid = await verifyStripeSignature(payload, req.headers.get("stripe-signature"));
  if (!isValid) return jsonResponse({ error: "Invalid Stripe signature." }, 400);

  try {
    const event = JSON.parse(payload);
    const admin = createAdminClient();

    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as StripeCheckoutSession;
        await syncPurchaseFromSession(admin, session);
        if (session.mode === "subscription" && session.subscription) {
          await syncSubscriptionFromStripe(admin, session.subscription);
        }
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object as StripeCheckoutSession;
        await syncPurchaseFromSession(admin, { ...session, payment_status: "unpaid", status: "expired" });
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as StripeSubscription;
        await syncSubscriptionFromStripe(admin, subscription.id);
        break;
      }
      case "charge.refunded": {
        await handleRefund(admin, event.data.object as Record<string, unknown>);
        break;
      }
      default:
        break;
    }

    return jsonResponse({ received: true });
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Webhook processing failed." }, 500);
  }
});
