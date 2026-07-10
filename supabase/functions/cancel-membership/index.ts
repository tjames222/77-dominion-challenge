import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { createFormBody, stripeRequest, toIsoDateTime } from "../_shared/stripe.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";

type StripeSubscription = {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  current_period_start: number | null;
  current_period_end: number | null;
};

const productKey = "dominion_membership";
const entitlementKey = "membership_active";

async function revokeMembershipAccess(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  sourceId: string | null,
  subscriptionStatus = "canceled",
) {
  const endedAt = new Date().toISOString();
  const { error } = await admin.from("entitlements").upsert({
    user_id: userId,
    entitlement_key: entitlementKey,
    status: "revoked",
    source_type: "subscription",
    source_id: sourceId,
    ends_at: endedAt,
    metadata: {
      productKey,
      subscriptionStatus,
      canceledFrom: "billing_page",
    },
  }, { onConflict: "user_id,entitlement_key" });

  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, req);

  try {
    const user = await requireUser(req);
    const admin = createAdminClient();
    const { data: subscription, error } = await admin
      .from("subscriptions")
      .select("id, stripe_subscription_id, status")
      .eq("user_id", user.id)
      .eq("product_key", productKey)
      .neq("status", "canceled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!subscription?.stripe_subscription_id) {
      await revokeMembershipAccess(admin, user.id, null);
      return jsonResponse({ canceled: false, accessRemoved: true }, 200, req);
    }

    const canceled = await stripeRequest(
      `/v1/subscriptions/${encodeURIComponent(subscription.stripe_subscription_id)}`,
      "DELETE",
      createFormBody({
        invoice_now: false,
        prorate: false,
        "cancellation_details[comment]": "Member canceled from the Dominion billing page.",
      }),
    ) as StripeSubscription;

    const canceledAt = toIsoDateTime(canceled.canceled_at) || new Date().toISOString();
    const updateResult = await admin
      .from("subscriptions")
      .update({
        status: canceled.status || "canceled",
        cancel_at_period_end: Boolean(canceled.cancel_at_period_end),
        current_period_start: toIsoDateTime(canceled.current_period_start),
        current_period_end: toIsoDateTime(canceled.current_period_end),
        canceled_at: canceledAt,
      })
      .eq("id", subscription.id)
      .eq("user_id", user.id);

    if (updateResult.error) throw updateResult.error;

    await revokeMembershipAccess(admin, user.id, canceled.id, canceled.status || "canceled");
    return jsonResponse({ canceled: true, accessRemoved: true, status: canceled.status || "canceled" }, 200, req);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unable to cancel membership." }, 500, req);
  }
});
