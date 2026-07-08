import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { createFormBody, getSiteUrl, stripeRequest } from "../_shared/stripe.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, req);

  try {
    const user = await requireUser(req);
    const admin = createAdminClient();
    const { data: customer, error } = await admin
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (!customer?.stripe_customer_id) {
      return jsonResponse({ error: "No billing account found yet." }, 404, req);
    }

    const session = await stripeRequest(
      "/v1/billing_portal/sessions",
      "POST",
      createFormBody({
        customer: customer.stripe_customer_id,
        return_url: `${getSiteUrl(req)}/profile.html#billing`,
      }),
    );

    return jsonResponse({ url: session.url }, 200, req);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unable to open billing portal." }, 500, req);
  }
});
