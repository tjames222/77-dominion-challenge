import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { getOrCreateStripeCustomer } from "../_shared/billing.ts";
import {
  createFormBody,
  getSiteUrl,
  stripeRequest,
} from "../_shared/stripe.ts";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  optionsResponse,
} from "../_shared/http.ts";

const allowedFlows = new Set(["payment_method_update"]);

export function resolveReturnUrl(
  siteUrl: string,
  returnPath: string | undefined,
  fallbackPath: string,
) {
  try {
    const url = new URL(returnPath || fallbackPath, `${siteUrl}/`);
    return url.origin === siteUrl ? url.href : `${siteUrl}${fallbackPath}`;
  } catch {
    return `${siteUrl}${fallbackPath}`;
  }
}

type Dependencies = {
  requireUser: typeof requireUser;
  createAdminClient: typeof createAdminClient;
  getOrCreateStripeCustomer: typeof getOrCreateStripeCustomer;
  getSiteUrl: typeof getSiteUrl;
  stripeRequest: typeof stripeRequest;
  logger: Pick<Console, "error">;
};

const defaultDependencies: Dependencies = {
  requireUser,
  createAdminClient,
  getOrCreateStripeCustomer,
  getSiteUrl,
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
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError("Request body must be a JSON object.", 400);
      }

      const requestBody = body as { flow?: unknown; returnPath?: unknown };
      if (
        requestBody.flow !== undefined &&
        (typeof requestBody.flow !== "string" ||
          !allowedFlows.has(requestBody.flow))
      ) {
        throw new HttpError("Unsupported portal flow.", 400);
      }
      if (
        requestBody.returnPath !== undefined &&
        typeof requestBody.returnPath !== "string"
      ) {
        throw new HttpError("returnPath must be a string.", 400);
      }

      const flow = typeof requestBody.flow === "string" ? requestBody.flow : "";
      const returnPath = typeof requestBody.returnPath === "string"
        ? requestBody.returnPath
        : undefined;
      const fallbackPath = flow === "payment_method_update"
        ? "/billing.html?payment=updated"
        : "/profile.html#billing";
      const siteUrl = dependencies.getSiteUrl(req);
      const admin = dependencies.createAdminClient();
      const stripeCustomerId = await dependencies.getOrCreateStripeCustomer(
        admin,
        user,
      );
      const sessionBody = createFormBody({
        customer: stripeCustomerId,
        return_url: resolveReturnUrl(siteUrl, returnPath, fallbackPath),
      });

      if (flow === "payment_method_update") {
        sessionBody.set("flow_data[type]", "payment_method_update");
        sessionBody.set("flow_data[after_completion][type]", "redirect");
        sessionBody.set(
          "flow_data[after_completion][redirect][return_url]",
          `${siteUrl}/billing.html?payment=updated`,
        );
      }

      const session = await dependencies.stripeRequest(
        "/v1/billing_portal/sessions",
        "POST",
        sessionBody,
      );

      return jsonResponse({ url: session.url }, 200, req);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) {
        dependencies.logger.error(error);
      }
      return errorResponse(error, "Unable to open billing portal.", req);
    }
  };
}

export const handler = createHandler();

if (import.meta.main) Deno.serve(handler);
