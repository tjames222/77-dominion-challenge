import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { getOrCreateStripeCustomer } from "../_shared/billing.ts";
import {
  createFormBody,
  getPriceId,
  getSiteUrl,
  stripeRequest,
} from "../_shared/stripe.ts";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  optionsResponse,
} from "../_shared/http.ts";

const subscriptionProductKey = "dominion_membership";
const subscriptionEntitlementKey = "membership_active";

type EntitlementSummary = {
  entitlement_key: string;
  status: string;
};

type Dependencies = {
  requireUser: typeof requireUser;
  createAdminClient: typeof createAdminClient;
  getOrCreateStripeCustomer: typeof getOrCreateStripeCustomer;
  getSiteUrl: typeof getSiteUrl;
  getPriceId: typeof getPriceId;
  stripeRequest: typeof stripeRequest;
  logger: Pick<Console, "error">;
};

const defaultDependencies: Dependencies = {
  requireUser,
  createAdminClient,
  getOrCreateStripeCustomer,
  getSiteUrl,
  getPriceId,
  stripeRequest,
  logger: console,
};

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async (req: Request) => {
    if (req.method === "OPTIONS") return optionsResponse(req);
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405, req);
    }

    try {
      const user = await dependencies.requireUser(req);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        throw new HttpError("Request body must be valid JSON.", 400);
      }

      const productKey =
        body && typeof body === "object" && "productKey" in body
          ? (body as { productKey?: unknown }).productKey
          : undefined;

      if (productKey !== subscriptionProductKey) {
        throw new HttpError("Unsupported product selection.", 400);
      }

      const admin = dependencies.createAdminClient();
      const { data: existingEntitlements, error: entitlementsError } =
        await admin
          .from("entitlements")
          .select("entitlement_key, status")
          .eq("user_id", user.id);

      if (entitlementsError) throw entitlementsError;

      const subscriptionActive = (existingEntitlements as
        | EntitlementSummary[]
        | null)?.some((item) =>
          item.entitlement_key === subscriptionEntitlementKey &&
          item.status === "active"
        );

      if (subscriptionActive) {
        return jsonResponse(
          {
            url: `${dependencies.getSiteUrl(req)}/dashboard.html`,
            alreadyOwned: true,
          },
          200,
          req,
        );
      }

      const stripeCustomerId = await dependencies.getOrCreateStripeCustomer(
        admin,
        user,
      );
      const siteUrl = dependencies.getSiteUrl(req);
      const priceId = dependencies.getPriceId(productKey);
      const successUrl = `${siteUrl}/billing.html?checkout=success&product=${
        encodeURIComponent(productKey)
      }`;
      const cancelUrl = `${siteUrl}/billing.html?checkout=canceled&product=${
        encodeURIComponent(productKey)
      }`;
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

      const session = await dependencies.stripeRequest(
        "/v1/checkout/sessions",
        "POST",
        sessionBody,
      );
      return jsonResponse({ url: session.url }, 200, req);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) {
        dependencies.logger.error(error);
      }
      return errorResponse(error, "Unable to create checkout session.", req);
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
