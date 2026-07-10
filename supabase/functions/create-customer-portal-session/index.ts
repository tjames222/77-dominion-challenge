import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { getOrCreateStripeCustomer } from "../_shared/billing.ts";
import { createFormBody, getSiteUrl, stripeRequest } from "../_shared/stripe.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";

const allowedFlows = new Set(["payment_method_update"]);

function resolveReturnUrl(siteUrl: string, returnPath: string | undefined, fallbackPath: string) {
  try {
    const url = new URL(returnPath || fallbackPath, `${siteUrl}/`);
    return url.origin === siteUrl ? url.href : `${siteUrl}${fallbackPath}`;
  } catch {
    return `${siteUrl}${fallbackPath}`;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, req);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const flow = typeof body.flow === "string" && allowedFlows.has(body.flow) ? body.flow : "";
    const returnPath = typeof body.returnPath === "string" ? body.returnPath : undefined;
    const fallbackPath = flow === "payment_method_update" ? "/billing.html?payment=updated" : "/profile.html#billing";
    const siteUrl = getSiteUrl(req);
    const admin = createAdminClient();
    const stripeCustomerId = await getOrCreateStripeCustomer(admin, user);
    const sessionBody = createFormBody({
      customer: stripeCustomerId,
      return_url: resolveReturnUrl(siteUrl, returnPath, fallbackPath),
    });

    if (flow === "payment_method_update") {
      sessionBody.set("flow_data[type]", "payment_method_update");
      sessionBody.set("flow_data[after_completion][type]", "redirect");
      sessionBody.set("flow_data[after_completion][redirect][return_url]", `${siteUrl}/billing.html?payment=updated`);
    }

    const session = await stripeRequest(
      "/v1/billing_portal/sessions",
      "POST",
      sessionBody,
    );

    return jsonResponse({ url: session.url }, 200, req);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unable to open billing portal." }, 500, req);
  }
});
