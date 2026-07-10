import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { getOrCreateStripeCustomer } from "../_shared/billing.ts";
import { createFormBody, getPriceId, getSiteUrl, stripeRequest } from "../_shared/stripe.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";

const subscriptionProductKey = "dominion_membership";
const subscriptionEntitlementKey = "membership_active";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, req);

  try {
    const user = await requireUser(req);
    const { productKey } = await req.json();

    if (productKey !== subscriptionProductKey) {
      return jsonResponse({ error: "Unsupported product selection." }, 400, req);
    }

    const admin = createAdminClient();
    const { data: existingEntitlements, error: entitlementsError } = await admin
      .from("entitlements")
      .select("entitlement_key, status")
      .eq("user_id", user.id);

    if (entitlementsError) throw entitlementsError;

    const subscriptionActive = existingEntitlements?.some((item) =>
      item.entitlement_key === subscriptionEntitlementKey && item.status === "active"
    );

    if (subscriptionActive) {
      return jsonResponse({ url: `${getSiteUrl(req)}/dashboard.html`, alreadyOwned: true }, 200, req);
    }

    const stripeCustomerId = await getOrCreateStripeCustomer(admin, user);
    const siteUrl = getSiteUrl(req);
    const priceId = getPriceId(productKey);
    const successUrl = `${siteUrl}/billing.html?checkout=success&product=${encodeURIComponent(productKey)}`;
    const cancelUrl = `${siteUrl}/billing.html?checkout=canceled&product=${encodeURIComponent(productKey)}`;
    const sessionBody = createFormBody({
      mode: "subscription",
      customer: stripeCustomerId,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      client_reference_id: user.id,
      "metadata[user_id]": user.id,
      "metadata[product_key]": productKey,
      "metadata[price_id]": priceId,
      "subscription_data[metadata][user_id]": user.id,
      "subscription_data[metadata][product_key]": productKey,
      "subscription_data[metadata][price_id]": priceId,
    });

    const session = await stripeRequest("/v1/checkout/sessions", "POST", sessionBody);
    return jsonResponse({ url: session.url }, 200, req);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unable to create checkout session." }, 500, req);
  }
});
