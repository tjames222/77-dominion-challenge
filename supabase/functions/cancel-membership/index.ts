import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import {
  createFormBody,
  stripeRequest,
  toIsoDateTime,
} from "../_shared/stripe.ts";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  optionsResponse,
} from "../_shared/http.ts";

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
  now: () => Date = () => new Date(),
) {
  const endedAt = now().toISOString();
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

type Dependencies = {
  requireUser: typeof requireUser;
  createAdminClient: typeof createAdminClient;
  stripeRequest: typeof stripeRequest;
  now: () => Date;
  logger: Pick<Console, "error">;
};

const defaultDependencies: Dependencies = {
  requireUser,
  createAdminClient,
  stripeRequest,
  now: () => new Date(),
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
      const admin = dependencies.createAdminClient();
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
        await revokeMembershipAccess(
          admin,
          user.id,
          null,
          "canceled",
          dependencies.now,
        );
        return jsonResponse({ canceled: false, accessRemoved: true }, 200, req);
      }

      const canceled = await dependencies.stripeRequest(
        `/v1/subscriptions/${
          encodeURIComponent(subscription.stripe_subscription_id)
        }`,
        "DELETE",
        createFormBody({
          invoice_now: false,
          prorate: false,
          "cancellation_details[comment]":
            "Member canceled from the Dominion billing page.",
        }),
      ) as StripeSubscription;

      const canceledAt = toIsoDateTime(canceled.canceled_at) ||
        dependencies.now().toISOString();
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

      await revokeMembershipAccess(
        admin,
        user.id,
        canceled.id,
        canceled.status || "canceled",
        dependencies.now,
      );
      return jsonResponse(
        {
          canceled: true,
          accessRemoved: true,
          status: canceled.status || "canceled",
        },
        200,
        req,
      );
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) {
        dependencies.logger.error(error);
      }
      return errorResponse(error, "Unable to cancel membership.", req);
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
