import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { createFormBody, getPriceId, getSiteUrl, stripeRequest } from "../_shared/stripe.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";

const challengeProducts = new Set(["challenge_77", "dominion_membership"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const { productKey } = await req.json();

    if (!challengeProducts.has(productKey)) {
      return jsonResponse({ error: "Unsupported product selection." }, 400);
    }

    const admin = createAdminClient();
    const [{ data: profile }, { data: existingEntitlements }, { data: existingCustomer }] = await Promise.all([
      admin
        .from("profiles")
        .select("name, email")
        .eq("user_id", user.id)
        .maybeSingle(),
      admin
        .from("entitlements")
        .select("entitlement_key, status")
        .eq("user_id", user.id),
      admin
        .from("billing_customers")
        .select("stripe_customer_id")
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

    const challengeActive = existingEntitlements?.some((item) => item.entitlement_key === "challenge_77_access" && item.status === "active");
    const membershipActive = existingEntitlements?.some((item) => item.entitlement_key === "membership_active" && item.status === "active");

    if (productKey === "challenge_77" && challengeActive) {
      return jsonResponse({ url: `${getSiteUrl(req)}/dashboard.html`, alreadyOwned: true });
    }

    if (productKey === "dominion_membership" && membershipActive) {
      return jsonResponse({ url: `${getSiteUrl(req)}/profile.html#billing`, alreadyOwned: true });
    }

    let stripeCustomerId = existingCustomer?.stripe_customer_id || null;
    if (!stripeCustomerId) {
      const customer = await stripeRequest(
        "/v1/customers",
        "POST",
        createFormBody({
          email: user.email || profile?.email || "",
          name: profile?.name || user.user_metadata?.name || "",
          "metadata[user_id]": user.id,
        }),
      );

      stripeCustomerId = customer.id;

      await admin.from("billing_customers").upsert({
        user_id: user.id,
        stripe_customer_id: stripeCustomerId,
        email: user.email || profile?.email || "",
      }, { onConflict: "user_id" });
    }

    const siteUrl = getSiteUrl(req);
    const priceId = getPriceId(productKey);
    const successUrl = `${siteUrl}/billing.html?checkout=success&product=${encodeURIComponent(productKey)}`;
    const cancelUrl = `${siteUrl}/billing.html?checkout=canceled&product=${encodeURIComponent(productKey)}`;
    const isMembership = productKey === "dominion_membership";
    const sessionBody = createFormBody({
      mode: isMembership ? "subscription" : "payment",
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
      ...(isMembership ? {
        "subscription_data[metadata][user_id]": user.id,
        "subscription_data[metadata][product_key]": productKey,
        "subscription_data[metadata][price_id]": priceId,
      } : {}),
    });

    const session = await stripeRequest("/v1/checkout/sessions", "POST", sessionBody);
    return jsonResponse({ url: session.url });
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unable to create checkout session." }, 500);
  }
});
